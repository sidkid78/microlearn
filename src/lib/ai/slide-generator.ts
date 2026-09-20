import { GoogleGenAI } from '@google/genai';
import type { ScriptScene } from './script-generator';

/**
 * Slides instead of rendered video.
 *
 * The pipeline used to generate a 60-second MP4 on Remotion Lambda. The
 * Gemini alternative, Omni, bills at roughly $0.10 per second of 720p
 * output — about $6.00 for one lesson, or $720 a month at four
 * professions a day. That is the wrong price for a talking diagram.
 *
 * A lesson does not need generated footage. It needs a picture per beat
 * and a voice over it, which is what most instructional content
 * actually is. Eight images plus narration lands near $0.32.
 *
 * The deeper win is that NOTHING IS RENDERED. `synthesizeSpeechWithAlignment`
 * already returns word-level timings, so the client can play the audio
 * and swap images on cue. That removes the whole render subsystem:
 * Remotion, AWS Lambda, the REMOTION_* variables, the poll-for-completion
 * step, and MP4 storage. A "video" becomes a manifest — one audio file,
 * a few JPEGs, and the times to show them.
 *
 * It is also better to live with. Regenerating one bad slide costs one
 * image; regenerating one bad second of MP4 costs the whole render.
 */

const IMAGE_MODEL = 'gemini-3.1-flash-image';

export interface Slide {
  sequence: number;
  /** Seconds from the start of the narration. */
  startSecond: number;
  endSecond: number;
  /** Storage path, filled in once the bytes are uploaded. */
  storagePath: string;
  /** Kept so a slide can be regenerated without re-deriving the prompt. */
  prompt: string;
  onScreenHook: string;
}

export interface SlideImage {
  sequence: number;
  bytes: Uint8Array;
  mimeType: string;
  prompt: string;
}

/**
 * An image prompt for one beat of the script.
 *
 * Built from what the script generator already produces — the hook, the
 * visual style and the icon keyword — rather than asking a model to
 * invent one. The script has already decided what this beat is about,
 * and a second opinion would drift from it.
 */
export function promptForScene(
  scene: ScriptScene,
  palette: { primary: string; accent: string; background: string },
  topicTitle: string
): string {
  const style: Record<ScriptScene['visual_style'], string> = {
    code_snippet: 'a clean editor-style panel of monospaced text, syntax highlighted',
    metric_callout: 'one large number or statistic as the focal point, minimal supporting label',
    framework_grid: 'a simple labelled diagram of three or four connected parts',
    warning_box: 'a single bold caution panel with a hazard motif, high contrast',
  };

  return [
    `Vertical 9:16 instructional slide for a micro-lesson about ${topicTitle}.`,
    `Composition: ${style[scene.visual_style] ?? style.framework_grid}.`,
    `Subject matter: ${scene.on_screen_hook}.`,
    `Include a clear ${scene.icon_keyword} motif.`,
    `Palette: background ${palette.background}, primary ${palette.primary}, accent ${palette.accent}.`,
    // Captions are drawn by the client from the word timings. A slide
    // with its own baked-in sentence would collide with them.
    'Flat vector illustration, generous negative space in the lower third,',
    'no captions, no subtitles, no paragraphs of text, no watermark.',
  ].join(' ');
}

/**
 * One image per scene.
 *
 * Sequential rather than parallel: image models rate-limit hard, and a
 * lesson is eight images, not eight hundred. A failed slide returns
 * null and the caller decides — a lesson missing one of eight slides is
 * still watchable, so this never throws the whole batch away for one
 * failure.
 */
export async function generateSlides(
  scenes: ScriptScene[],
  palette: { primary: string; accent: string; background: string },
  topicTitle: string
): Promise<SlideImage[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY environment variable');
  }
  const ai = new GoogleGenAI({ apiKey });

  const out: SlideImage[] = [];
  for (const scene of scenes) {
    const prompt = promptForScene(scene, palette, topicTitle);
    try {
      const interaction = await ai.interactions.create({
        model: IMAGE_MODEL,
        input: prompt,
        response_format: { type: 'image', aspect_ratio: '9:16' },
      });
      const image = interaction.output_image;
      if (!image?.data) continue;
      out.push({
        sequence: scene.sequence,
        bytes: Uint8Array.from(Buffer.from(image.data, 'base64')),
        mimeType: image.mime_type || 'image/png',
        prompt,
      });
    } catch {
      // A missing slide is a gap in the deck, not a failed lesson.
      continue;
    }
  }
  return out;
}

/**
 * Cue points for the client.
 *
 * The script's own scene boundaries are used when the narration came out
 * near its target length. When it did not — TTS pace varies and the real
 * audio is the thing being played — the boundaries are scaled to the
 * measured duration, so the last slide ends exactly when the voice
 * stops rather than hanging or cutting off.
 */
export function buildSlideManifest(
  scenes: ScriptScene[],
  storagePaths: Map<number, string>,
  audioDurationSeconds: number
): Slide[] {
  const scripted = scenes.reduce((max, s) => Math.max(max, s.end_second), 0) || 1;
  const scale = audioDurationSeconds / scripted;

  return scenes
    .filter((scene) => storagePaths.has(scene.sequence))
    .map((scene) => ({
      sequence: scene.sequence,
      startSecond: Number((scene.start_second * scale).toFixed(3)),
      endSecond: Number((scene.end_second * scale).toFixed(3)),
      storagePath: storagePaths.get(scene.sequence) as string,
      prompt: '',
      onScreenHook: scene.on_screen_hook,
    }));
}
