import { GoogleGenAI } from '@google/genai';

/**
 * Narration and caption timings, on Gemini only.
 *
 * This used to call ElevenLabs' /with-timestamps endpoint, which returns
 * audio and per-character alignment in one request. Gemini splits that
 * into two steps, and the result is better in one respect and worse in
 * another:
 *
 *   duration   EXACT here. The TTS model returns raw PCM, so the length
 *              is a byte count, not the end timestamp of the last word
 *              the aligner happened to find.
 *   timings    a second call. The TTS models do not emit alignment, so
 *              the generated audio is passed back to a Gemini model for
 *              timing.
 *
 * The timing call is given the SCRIPT as well as the audio, and asked to
 * time those exact words rather than transcribe freely. Left to
 * transcribe, the model normalises as it hears — "sixty second" came
 * back as "60-second" — and captions then disagree with the script the
 * video was built from.
 */

const TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const ALIGN_MODEL = 'gemini-3.8-flash';
const SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2; // 16-bit mono

export interface WordAlignment {
  word: string;
  start: number;
  end: number;
}

export interface TTSResult {
  audioBuffer: ArrayBuffer;
  durationSeconds: number;
  words: WordAlignment[];
}

/**
 * Wrap raw PCM in a WAV container.
 *
 * The TTS model returns `audio/l16; rate=24000; channels=1` — headerless
 * samples. Nothing downstream can play or mux that: not a browser, not
 * ffmpeg without being told the format, and not the model that has to
 * time it. Forty-four bytes of header makes it a real file.
 */
function pcmToWav(pcm: Uint8Array, sampleRate = SAMPLE_RATE): ArrayBuffer {
  const out = new ArrayBuffer(44 + pcm.length);
  const view = new DataView(out);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);               // PCM chunk size
  view.setUint16(20, 1, true);                // format: PCM
  view.setUint16(22, 1, true);                // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 16, true);               // bits per sample
  ascii(36, 'data');
  view.setUint32(40, pcm.length, true);
  new Uint8Array(out, 44).set(pcm);
  return out;
}

/**
 * Timings spread across the duration by character count.
 *
 * Used when the alignment call fails or returns something unusable. It
 * is an approximation — longer words take longer to say, which is
 * roughly true — but it always produces captions covering the whole
 * script, and a caption slightly out of step is better than a video
 * with none.
 */
function proportionalAlignment(script: string, durationSeconds: number): WordAlignment[] {
  const tokens = script.split(/\s+/).filter(Boolean);
  const total = tokens.reduce((n, w) => n + w.length, 0) || 1;
  let elapsed = 0;
  return tokens.map((word) => {
    const span = (word.length / total) * durationSeconds;
    const start = elapsed;
    elapsed += span;
    return { word, start: Number(start.toFixed(3)), end: Number(elapsed.toFixed(3)) };
  });
}

function parseAlignment(text: string): WordAlignment[] | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as { words?: WordAlignment[] };
    const words = (parsed.words || []).filter(
      (w) => typeof w?.word === 'string' && Number.isFinite(w?.start) && Number.isFinite(w?.end)
    );
    return words.length ? words : null;
  } catch {
    return null;
  }
}

export async function synthesizeSpeechWithAlignment(
  text: string,
  voice: string = 'Kore'
): Promise<TTSResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY environment variable');
  }

  const ai = new GoogleGenAI({ apiKey });

  const speech = await ai.interactions.create({
    model: TTS_MODEL,
    input: text,
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice }] },
  });

  const encoded = speech.output_audio?.data;
  if (!encoded) {
    throw new Error('Gemini TTS returned no audio');
  }

  const pcm = Uint8Array.from(Buffer.from(encoded, 'base64'));
  const audioBuffer = pcmToWav(pcm);
  // Exact: samples / rate. No dependence on where an aligner thought the
  // last word ended.
  const durationSeconds = Number((pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)).toFixed(3));

  let words: WordAlignment[] | null = null;
  try {
    const aligned = await ai.interactions.create({
      model: ALIGN_MODEL,
      input: [
        {
          type: 'audio',
          data: Buffer.from(audioBuffer).toString('base64'),
          mime_type: 'audio/wav',
        },
        {
          type: 'text',
          text:
            `This audio is a reading of the script below. Give the start and end time ` +
            `of each word AS WRITTEN in the script — do not re-transcribe, do not ` +
            `normalise numbers or spelling, and keep the script's own word order and ` +
            `spelling exactly.\n\nSCRIPT:\n${text}\n\n` +
            `Reply with JSON only: {"words":[{"word":"A","start":0.0,"end":0.12}]}. ` +
            `Times are seconds from the start of the audio; the audio is ` +
            `${durationSeconds} seconds long.`,
        },
      ],
    });
    words = parseAlignment(aligned.output_text || '');
  } catch {
    words = null; // fall through to the proportional estimate
  }

  return {
    audioBuffer,
    durationSeconds,
    words: words ?? proportionalAlignment(text, durationSeconds),
  };
}
