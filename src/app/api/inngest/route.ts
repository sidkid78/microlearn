import { serve } from "inngest/next";
import { inngest, type VideoGenerationEventData } from "../../../lib/inngest/client";
import { generateInstructionalScript } from "../../../lib/ai/script-generator";
import { synthesizeSpeechWithAlignment } from "../../../lib/ai/tts-alignment";
import { buildSlideManifest, generateSlides } from "../../../lib/ai/slide-generator";
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

    const ttsResult = await step.run("synthesize-audio-gemini-tts", async () => {
      const tts = await synthesizeSpeechWithAlignment(scriptResult.full_voiceover_script);

      // A permanent path, not temp_audio/. The narration is no longer an
      // intermediate that gets muxed into an MP4 and thrown away — it is
      // the asset the player loads. Gemini TTS returns WAV, not MP3.
      const audioStoragePath = `narration/${professionSlug}/${videoId}.wav`;
      const { error: uploadError } = await supabaseAdmin.storage
        .from("learning-videos")
        .upload(audioStoragePath, tts.audioBuffer, {
          contentType: "audio/wav",
          upsert: true,
        });

      if (uploadError) throw uploadError;

      return {
        audioStoragePath,
        durationSeconds: tts.durationSeconds,
        words: tts.words,
      };
    });

    const slides = await step.run("generate-slides", async () => {
      await supabaseAdmin
        .from("generated_videos")
        .update({
          generation_status: "rendering",
          script: scriptResult.full_voiceover_script,
          captions: JSON.parse(JSON.stringify(ttsResult.words)),
          duration_seconds: ttsResult.durationSeconds,
        })
        .eq("id", videoId);

      // One image per script beat, instead of generating footage.
      // Omni bills about $0.10 per second of 720p video, so a 60 second
      // lesson costs roughly $6.00 to render; eight slides cost about
      // $0.32. A talking diagram does not need generated video.
      const images = await generateSlides(
        scriptResult.scenes,
        scriptResult.color_palette,
        scriptResult.title
      );

      if (images.length === 0) {
        throw new Error("No slides were generated for this lesson");
      }

      const paths = new Map<number, string>();
      for (const image of images) {
        const ext = image.mimeType.includes("png") ? "png" : "jpg";
        const path = `slides/${professionSlug}/${videoId}/${image.sequence}.${ext}`;
        const { error } = await supabaseAdmin.storage
          .from("learning-videos")
          .upload(path, image.bytes, { contentType: image.mimeType, upsert: true });
        if (error) throw error;
        paths.set(image.sequence, path);
      }

      // Cue points are scaled to the MEASURED narration length. The
      // script's own scene boundaries are a target; TTS pace is what
      // actually happened, and the slides have to follow the voice.
      return buildSlideManifest(scriptResult.scenes, paths, ttsResult.durationSeconds);
    });

    const finalAssetPaths = await step.run("ingest-assets-to-supabase", async () => {
      // Nothing is rendered, so there is nothing to fetch and re-upload.
      // The narration and the slides are already in storage; this step
      // records what they are.
      //
      // `video_storage_path` holds the AUDIO path. The column name
      // predates slides and is kept rather than migrated: it means "the
      // asset the player loads", which is now a .wav. The slide manifest
      // travels in ai_metadata, and the first slide is the poster.
      const thumbnailStoragePath = slides[0]?.storagePath ?? "";

      const { error: dbUpdateErr } = await supabaseAdmin
        .from("generated_videos")
        .update({
          generation_status: "ready",
          video_storage_path: ttsResult.audioStoragePath,
          thumbnail_storage_path: thumbnailStoragePath,
          ai_metadata: JSON.parse(JSON.stringify({
            format: "slides+narration",
            palette: scriptResult.color_palette,
            scenes: scriptResult.scenes,
            slides,
            script_model: "gemini-3.8-flash",
            tts_model: "gemini-3.1-flash-tts-preview",
            image_model: "gemini-3.1-flash-image",
          })),
        })
        .eq("id", videoId);

      if (dbUpdateErr) throw dbUpdateErr;

      return { videoStoragePath: ttsResult.audioStoragePath, thumbnailStoragePath };
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
