/**
 * seed-dev-lesson.mjs — generate real lessons: script, narration, slides.
 *
 * Runs what the Inngest pipeline runs, without Inngest, for every
 * delivery whose video has no slides yet. Local only.
 *
 *   node scripts/seed-dev-lesson.mjs
 */
import { readFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n')
    .map((l) => l.match(/^([A-Z_]+)="?([^"\n]*)"?$/)).filter(Boolean)
    .map((m) => [m[1], m[2]])
);
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const AI_KEY = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
if (!/127\.0\.0\.1|localhost/.test(URL_)) throw new Error(`refusing non-local: ${URL_}`);
if (!AI_KEY) throw new Error('set GEMINI_API_KEY in .env.local');

const SCRIPT_MODEL = 'gemini-3.8-flash';
const TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const IMAGE_MODEL = 'gemini-3.1-flash-image';
const PALETTE = { primary: '#f97316', accent: '#fbbf24', background: '#0f172a' };

const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const ai = new GoogleGenAI({ apiKey: AI_KEY });

const rest = async (path, init = {}) => {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init, headers: { ...h, Prefer: 'return=representation', ...(init.headers || {}) },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
};

const upload = async (bucket, path, bytes, contentType) => {
  const r = await fetch(`${URL_}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': contentType, 'x-upsert': 'true' },
    body: bytes,
  });
  if (!r.ok) throw new Error(`upload ${path} -> ${r.status} ${await r.text()}`);
};

function pcmToWav(pcm, rate = 24000) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

const json = (text) => {
  const body = text.replace(/```json|```/g, '').trim();
  return JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
};

async function buildLesson(video) {
  const title = video.title;
  console.log(`\n${title}`);

  // 1. beats — the same shape the real script generator emits
  const scripted = await ai.interactions.create({
    model: SCRIPT_MODEL,
    input:
      `Write a four-beat micro-lesson for a working tradesperson about "${title}". ` +
      `Each beat is one or two spoken sentences a narrator reads, plus a short ` +
      `on-screen hook of at most six words describing what the slide shows. ` +
      `Be concrete and practical — name what to look at and what it means. ` +
      `JSON only: {"beats":[{"hook":"...","text":"..."}]}`,
  });
  const beats = json(scripted.output_text).beats.slice(0, 4);
  const script = beats.map((b) => b.text).join(' ');
  console.log(`  script    ${beats.length} beats, ${script.split(/\s+/).length} words`);

  // 2. narration
  const speech = await ai.interactions.create({
    model: TTS_MODEL, input: script,
    response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice: 'Kore' }] },
  });
  const pcm = Buffer.from(speech.output_audio.data, 'base64');
  const wav = pcmToWav(pcm);
  const duration = Number((pcm.length / (24000 * 2)).toFixed(3));
  const audioPath = `narration/dev/${video.id}.wav`;
  await upload('learning-videos', audioPath, wav, 'audio/wav');
  console.log(`  narration ${duration}s`);

  // 3. word timings, against the KNOWN script so captions cannot drift
  let words = [];
  try {
    const aligned = await ai.interactions.create({
      model: SCRIPT_MODEL,
      input: [
        { type: 'audio', data: wav.toString('base64'), mime_type: 'audio/wav' },
        { type: 'text', text:
          `Time each word AS WRITTEN below. Do not re-transcribe or normalise numbers.\n\n` +
          `SCRIPT:\n${script}\n\nJSON only: {"words":[{"word":"A","start":0.0,"end":0.1}]}. ` +
          `Audio is ${duration}s.` },
      ],
    });
    words = json(aligned.output_text).words;
  } catch {
    words = [];
  }
  console.log(`  captions  ${words.length} words`);

  // 4. one slide per beat
  const slides = [];
  const span = duration / beats.length;
  for (const [i, beat] of beats.entries()) {
    const seq = i + 1;
    const interaction = await ai.interactions.create({
      model: IMAGE_MODEL,
      input:
        `Vertical 9:16 instructional slide for a micro-lesson about ${title}. ` +
        `Subject: ${beat.hook}. Flat vector illustration, background ${PALETTE.background}, ` +
        `primary ${PALETTE.primary}, accent ${PALETTE.accent}. Generous negative space in the ` +
        `lower third. No captions, no subtitles, no text, no watermark.`,
      response_format: { type: 'image', aspect_ratio: '9:16' },
    });
    const img = interaction.output_image;
    if (!img?.data) continue;
    const ext = (img.mime_type || 'image/jpeg').includes('png') ? 'png' : 'jpg';
    const path = `slides/dev/${video.id}/${seq}.${ext}`;
    await upload('learning-videos', path, Buffer.from(img.data, 'base64'), img.mime_type);
    slides.push({
      sequence: seq,
      startSecond: Number((i * span).toFixed(3)),
      endSecond: Number(((i + 1) * span).toFixed(3)),
      storagePath: path,
      onScreenHook: beat.hook,
    });
    console.log(`  slide ${seq}   ${beat.hook}`);
  }
  if (slides.length === 0) throw new Error('no slides generated');

  await rest(`generated_videos?id=eq.${video.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      generation_status: 'ready',
      script,
      captions: { words },
      duration_seconds: duration,
      video_storage_path: audioPath,
      thumbnail_storage_path: slides[0].storagePath,
      ai_metadata: { format: 'slides+narration', palette: PALETTE, slides },
    }),
  });
}

// Every video attached to a delivery that has no slides yet.
const deliveries = await rest(
  'user_feed_deliveries?select=video:generated_videos(id,title,ai_metadata)&order=scheduled_for.desc'
);
const pending = deliveries
  .map((d) => d.video)
  .filter((v) => v && !(v.ai_metadata?.slides?.length));

if (pending.length === 0) {
  console.log('every delivery already has a lesson');
} else {
  console.log(`generating ${pending.length} lesson(s)`);
  for (const video of pending) await buildLesson(video);
  console.log('\ndone — reload the feed');
}
