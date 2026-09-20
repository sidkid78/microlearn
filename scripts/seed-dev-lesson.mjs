/**
 * seed-dev-lesson.mjs — generate one real lesson: narration + slides.
 *
 * Runs the same pipeline the Inngest job runs, without Inngest: TTS for
 * the voice, one image per beat, upload both, and attach the cue points
 * to an existing delivery. Local only.
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
if (!AI_KEY) throw new Error('set GEMINI_API_KEY in .env.local to generate a lesson');

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

const [video] = await rest('generated_videos?select=id,title,topic_id&order=created_at.asc&limit=1');
if (!video) throw new Error('no generated_videos row — run seed-dev-user.mjs first');
console.log(`lesson    ${video.title}`);

const BEATS = [
  { seq: 1, hook: 'Why flashing fails first', text: 'Flashing is the thinnest defence on a roof, and it fails before the shingles do.' },
  { seq: 2, hook: 'Check the chimney saddle', text: 'Start at the chimney. Look for a saddle behind it, and step flashing woven into every course.' },
  { seq: 3, hook: 'Valleys collect everything', text: 'Valleys carry the most water. Lift the shingle edge and check the metal underneath for rust or gaps.' },
  { seq: 4, hook: 'Seal is not a fix', text: 'If you find sealant doing the work of metal, that is a repair waiting to leak again.' },
];
const script = BEATS.map((b) => b.text).join(' ');

// 1. narration
const speech = await ai.interactions.create({
  model: 'gemini-3.1-flash-tts-preview', input: script,
  response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice: 'Kore' }] },
});
const pcm = Buffer.from(speech.output_audio.data, 'base64');
const wav = pcmToWav(pcm);
const duration = Number((pcm.length / (24000 * 2)).toFixed(3));
const audioPath = `narration/dev/${video.id}.wav`;
await upload('learning-videos', audioPath, wav, 'audio/wav');
console.log(`narration ${duration}s -> ${audioPath}`);

// 2. word timings
const aligned = await ai.interactions.create({
  model: 'gemini-3.8-flash',
  input: [
    { type: 'audio', data: wav.toString('base64'), mime_type: 'audio/wav' },
    { type: 'text', text: `Time each word AS WRITTEN below. Do not re-transcribe or normalise.\n\nSCRIPT:\n${script}\n\nJSON only: {"words":[{"word":"A","start":0.0,"end":0.1}]}. Audio is ${duration}s.` },
  ],
});
const words = JSON.parse((aligned.output_text || '').replace(/```json|```/g, '').trim()).words;
console.log(`captions  ${words.length} words`);

// 3. one slide per beat
const palette = { primary: '#f97316', accent: '#fbbf24', background: '#0f172a' };
const slides = [];
for (const beat of BEATS) {
  const interaction = await ai.interactions.create({
    model: 'gemini-3.1-flash-image',
    input: `Vertical 9:16 instructional slide for a roofing micro-lesson. Subject: ${beat.hook}. `
      + `Flat vector illustration, background ${palette.background}, primary ${palette.primary}, accent ${palette.accent}. `
      + `Generous negative space in the lower third. No captions, no subtitles, no text, no watermark.`,
    response_format: { type: 'image', aspect_ratio: '9:16' },
  });
  const img = interaction.output_image;
  const ext = (img.mime_type || 'image/jpeg').includes('png') ? 'png' : 'jpg';
  const path = `slides/dev/${video.id}/${beat.seq}.${ext}`;
  await upload('learning-videos', path, Buffer.from(img.data, 'base64'), img.mime_type);
  const span = duration / BEATS.length;
  slides.push({
    sequence: beat.seq,
    startSecond: Number(((beat.seq - 1) * span).toFixed(3)),
    endSecond: Number((beat.seq * span).toFixed(3)),
    storagePath: path,
    onScreenHook: beat.hook,
  });
  console.log(`slide ${beat.seq}   ${beat.hook}`);
}

// 4. record it
await rest(`generated_videos?id=eq.${video.id}`, {
  method: 'PATCH',
  body: JSON.stringify({
    generation_status: 'ready',
    script,
    captions: { words },
    duration_seconds: duration,
    video_storage_path: audioPath,
    thumbnail_storage_path: slides[0].storagePath,
    ai_metadata: { format: 'slides+narration', palette, slides },
  }),
});
console.log('\nlesson ready — reload the feed');
