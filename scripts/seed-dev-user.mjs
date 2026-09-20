/**
 * seed-dev-user.mjs — a real user with real feed data, for local dev.
 *
 * The home page gates twice: no session shows the locked card, and no
 * entitlement shows it again. Both gates are correct, so seeing the feed
 * means having a user who genuinely passes them rather than weakening
 * the checks.
 *
 * Creates an auth user, a profile on the top tier, a topic, a video, a
 * streak, and three scheduled deliveries. Idempotent: re-running reuses
 * the existing user instead of erroring.
 *
 * LOCAL ONLY. It uses the service role key, which bypasses RLS, and it
 * refuses to run against anything that is not 127.0.0.1.
 *
 *   node scripts/seed-dev-user.mjs
 */
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .map((l) => l.match(/^([A-Z_]+)="?([^"\n]*)"?$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]])
);

const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL = 'dev@localhost.test';
const PASSWORD = 'devpassword123';

if (!URL_ || !KEY) throw new Error('missing Supabase env in .env.local');
if (!/127\.0\.0\.1|localhost/.test(URL_)) {
  throw new Error(`refusing to seed a non-local project: ${URL_}`);
}

const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function rest(path, init = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init,
    headers: { ...h, Prefer: 'return=representation', ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// 1. the auth user
async function ensureUser() {
  const list = await fetch(`${URL_}/auth/v1/admin/users?per_page=200`, { headers: h })
    .then((r) => r.json());
  const existing = (list.users || []).find((u) => u.email === EMAIL);
  if (existing) return existing.id;

  const res = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, email_confirm: true }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`create user -> ${JSON.stringify(body)}`);
  return body.id;
}

const userId = await ensureUser();
console.log(`user      ${EMAIL}  ${userId}`);

// 2. the highest tier available, and any profession
const tiers = await rest('subscription_tiers?select=id,slug,daily_video_limit&order=daily_video_limit.desc');
const professions = await rest('niche_professions?select=id,slug&limit=1');
const tier = tiers[0];
console.log(`tier      ${tier.slug} (limit ${tier.daily_video_limit})`);

// 3. profile — the entitlement check reads subscription_status and tier
await rest('profiles', {
  method: 'POST',
  headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
  body: JSON.stringify({
    id: userId,
    email: EMAIL,
    full_name: 'Dev User',
    tier_id: tier.id,
    subscription_status: 'active',
    selected_profession_id: professions[0]?.id ?? null,
    delivery_hour_utc: 12,
    timezone: 'UTC',
  }),
});
console.log('profile   created');

// 4. a streak, so the header renders something
await rest('user_streaks', {
  method: 'POST',
  headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
  body: JSON.stringify({ user_id: userId, current_streak: 7, longest_streak: 12, freeze_tokens_remaining: 2 }),
});
console.log('streak    7 day');

// 5. topics + videos + deliveries
const SEED = [
  ['Roof Flashing Inspection', 'Inspection', 2],
  ['Ice Dam Prevention', 'Maintenance', 1],
  ['Reading a Moisture Meter', 'Diagnostics', 3],
];

const existing = await rest(`user_feed_deliveries?user_id=eq.${userId}&select=id`);
if (existing.length) {
  console.log(`deliveries ${existing.length} already present, skipping`);
  console.log(`
Set DEV_BYPASS_USER_ID="${userId}" in .env.local to view the feed without signing in.`);
  process.exit(0);
}

let n = 0;
for (const [title, category, difficulty] of SEED) {
  const [topic] = await rest('topics', {
    method: 'POST',
    body: JSON.stringify({
      title, category, difficulty_level: difficulty,
      profession_id: professions[0]?.id ?? null,
    }),
  });
  const [video] = await rest('generated_videos', {
    method: 'POST',
    body: JSON.stringify({
      topic_id: topic.id,
      title,
      script: `A sixty second walkthrough of ${title.toLowerCase()}.`,
      generation_status: 'ready',
      duration_seconds: 60,
      video_storage_path: `videos/dev-${n}.mp4`,
      thumbnail_storage_path: `thumbnails/dev-${n}.jpg`,
      captions: [],
      ai_metadata: { seeded: true },
    }),
  });
  await rest('user_feed_deliveries', {
    method: 'POST',
    body: JSON.stringify({
      user_id: userId,
      video_id: video.id,
      scheduled_for: new Date(Date.now() - n * 86400000).toISOString(),
      status: 'delivered',
      // is_completed is a generated column: derived from watch progress,
      // so Postgres rejects any value written to it.
      watch_duration_seconds: 0,
    }),
  });
  n += 1;
}
console.log(`deliveries ${n} scheduled`);
console.log(`\nSet DEV_BYPASS_USER_ID="${userId}" in .env.local to view the feed without signing in.`);
