import { serve } from "inngest/next";
import { inngest, type VideoGenerationEventData } from "../../../lib/inngest/client";
import { generateInstructionalScript } from "../../../lib/ai/script-generator";
import { synthesizeSpeechWithAlignment } from "../../../lib/ai/tts-alignment";
import { dispatchRemotionRender, pollRenderStatus } from "../../../lib/remotion/renderer";
import { getSupabaseAdmin } from "../../../lib/supabase/service";

const processVideoGenerationPipeline = inngest.createFunction(
  {
    id: "microlearn-video-generation-pipeline",
    triggers: [{ event: "pipeline/video.generate" }],
    concurrency: {
      limit: 5,
    },
    retries: 3,
  },
  async ({ event, step }) => {
    const data = event.data as VideoGenerationEventData;
    const { videoId, topicId, professionSlug, topicTitle, category, difficultyLevel } = data;
    const supabaseAdmin = getSupabaseAdmin();

    await step.run("set-status-scripting", async () => {
      const { error } = await supabaseAdmin
        .from("generated_videos")
        .update({ generation_status: "scripting" })
        .eq("id", videoId);
      if (error) throw error;
    });

    const scriptResult = await step.run("generate-script-gemini", async () => {
      return await generateInstructionalScript({
        profession: professionSlug,
        topicTitle,
        category,
        difficulty: difficultyLevel,
      });
    });

    const ttsResult = await step.run("synthesize-audio-elevenlabs", async () => {
      const tts = await synthesizeSpeechWithAlignment(scriptResult.full_voiceover_script);

      const audioFileName = `temp_audio/${videoId}.mp3`;
      const { error: uploadError } = await supabaseAdmin.storage
        .from("learning-videos")
        .upload(audioFileName, tts.audioBuffer, {
          contentType: "audio/mpeg",
          upsert: true,
        });

      if (uploadError) throw uploadError;

      const { data: signedAudio } = await supabaseAdmin.storage
        .from("learning-videos")
        .createSignedUrl(audioFileName, 3600);

      if (!signedAudio) throw new Error("Failed to create signed URL for audio asset");

      return {
        signedAudioUrl: signedAudio.signedUrl,
        durationSeconds: tts.durationSeconds,
        words: tts.words,
      };
    });

    const renderInit = await step.run("dispatch-remotion-render", async () => {
      await supabaseAdmin
        .from("generated_videos")
        .update({
          generation_status: "rendering",
          script: scriptResult.full_voiceover_script,
          captions: JSON.parse(JSON.stringify(ttsResult.words)),
          duration_seconds: Math.min(ttsResult.durationSeconds, 60.0),
          ai_metadata: JSON.parse(JSON.stringify({
            palette: scriptResult.color_palette,
            scenes: scriptResult.scenes,
            model: "gemini-3.7-flash",
          })),
        })
        .eq("id", videoId);

      return await dispatchRemotionRender({
        videoId,
        audioUrl: ttsResult.signedAudioUrl,
        scenes: scriptResult.scenes,
        words: ttsResult.words,
        colorPalette: scriptResult.color_palette,
      });
    });

    const renderCompletion = await step.run("poll-render-completion", async () => {
      let isComplete = false;
      let attempts = 0;
      let finalOutputUrl = "";

      while (!isComplete && attempts < 30) {
        attempts++;
        const poll = await pollRenderStatus(renderInit.renderId, renderInit.bucketName);

        if (poll.error) {
          throw new Error(`Remotion Lambda render failed: ${poll.error}`);
        }

        if (poll.done && poll.outputUrl) {
          isComplete = true;
          finalOutputUrl = poll.outputUrl;
          break;
        }

        await new Promise((res) => setTimeout(res, 10000));
      }

      if (!finalOutputUrl) {
        throw new Error("Render polling timed out after 300 seconds.");
      }

      return { outputUrl: finalOutputUrl };
    });

    const finalAssetPaths = await step.run("ingest-assets-to-supabase", async () => {
      const videoResponse = await fetch(renderCompletion.outputUrl);
      const videoArrayBuffer = await videoResponse.arrayBuffer();

      const videoStoragePath = `masters/${professionSlug}/${videoId}.mp4`;
      const thumbnailStoragePath = `posters/${professionSlug}/${videoId}.webp`;

      const { error: videoUploadErr } = await supabaseAdmin.storage
        .from("learning-videos")
        .upload(videoStoragePath, videoArrayBuffer, {
          contentType: "video/mp4",
          upsert: true,
        });

      if (videoUploadErr) throw videoUploadErr;

      const dummyPosterArrayBuffer = new TextEncoder().encode("RIFF....WEBPVP8").buffer;
      const { error: thumbUploadErr } = await supabaseAdmin.storage
        .from("learning-thumbnails")
        .upload(thumbnailStoragePath, dummyPosterArrayBuffer, {
          contentType: "image/webp",
          upsert: true,
        });

      if (thumbUploadErr) throw thumbUploadErr;

      const { error: dbUpdateErr } = await supabaseAdmin
        .from("generated_videos")
        .update({
          generation_status: "ready",
          video_storage_path: videoStoragePath,
          thumbnail_storage_path: thumbnailStoragePath,
        })
        .eq("id", videoId);

      if (dbUpdateErr) throw dbUpdateErr;

      return { videoStoragePath, thumbnailStoragePath };
    });

    await step.run("distribute-feed-deliveries", async () => {
      const today = new Date().toISOString().split("T")[0];

      const { data: users, error: userQueryErr } = await supabaseAdmin
        .from("profiles")
        .select("id, tier_id")
        .eq("selected_profession_id", topicId)
        .in("subscription_status", ["active", "trialing"]);

      if (userQueryErr || !users || users.length === 0) return;

      const deliveries = users.map((user) => ({
        user_id: user.id,
        video_id: videoId,
        scheduled_for: today,
        status: "queued" as const,
      }));

      await supabaseAdmin
        .from("user_feed_deliveries")
        .upsert(deliveries, { onConflict: "user_id,video_id,scheduled_for" });
    });

    return { success: true, videoId };
  }
);

const scheduleDailyVideoGeneration = inngest.createFunction(
  {
    id: "schedule-daily-video-generation",
    triggers: [{ cron: "0 2 * * *" }],
  },
  async ({ step }) => {
    const supabaseAdmin = getSupabaseAdmin();

    const professions = await step.run("fetch-active-professions", async () => {
      const { data, error } = await supabaseAdmin
        .from("niche_professions")
        .select("id, slug")
        .eq("is_active", true);
      if (error) throw error;
      return data || [];
    });

    for (const profession of professions) {
      await step.run(`queue-profession-${profession.slug}`, async () => {
        const { data: topic, error: topicErr } = await supabaseAdmin
          .from("topics")
          .select("id, title, category, difficulty_level")
          .eq("profession_id", profession.id)
          .limit(1)
          .maybeSingle();

        if (topicErr || !topic) return;

        const { data: videoRecord, error: videoErr } = await supabaseAdmin
          .from("generated_videos")
          .insert({
            topic_id: topic.id,
            title: topic.title,
            script: "Pending generation...",
            video_storage_path: "pending",
            thumbnail_storage_path: "pending",
            generation_status: "pending",
          })
          .select("id")
          .single();

        if (videoErr || !videoRecord) return;

        await inngest.send({
          name: "pipeline/video.generate",
          data: {
            videoId: videoRecord.id,
            topicId: topic.id,
            professionSlug: profession.slug,
            topicTitle: topic.title,
            category: topic.category,
            difficultyLevel: topic.difficulty_level,
          },
        });
      });
    }
  }
);

const handlePipelineFailure = inngest.createFunction(
  {
    id: "handle-pipeline-failure",
    triggers: [{ event: "inngest/function.failed" }],
  },
  async ({ event }) => {
    const data = event.data as {
      event?: { name: string; data: { videoId: string } };
      error?: { message: string; name: string; stack: string };
    };

    const originalEvent = data.event;
    const errorDetails = data.error;
    const supabaseAdmin = getSupabaseAdmin();

    if (originalEvent && originalEvent.name === "pipeline/video.generate") {
      const videoId = originalEvent.data.videoId;

      await supabaseAdmin
        .from("generated_videos")
        .update({
          generation_status: "failed",
          render_errors: JSON.stringify({
            message: errorDetails?.message,
            name: errorDetails?.name,
            stack: errorDetails?.stack,
            timestamp: new Date().toISOString(),
          }),
        })
        .eq("id", videoId);
    }
  }
);

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    processVideoGenerationPipeline,
    scheduleDailyVideoGeneration,
    handlePipelineFailure,
  ],
});
