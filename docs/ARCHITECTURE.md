# Architecture

## Data model

Seven tables, defined in `supabase/migrations/0001_db_schema_rls.sql` and
typed in `src/lib/database.types.ts`.

| Table | Holds |
| --- | --- |
| `niche_professions` | the audiences content is produced for; the pipeline iterates the active ones |
| `topics` | per-profession subjects, with category and difficulty |
| `generated_videos` | one row per produced lesson: script, storage paths, `generation_status`, captions, AI metadata |
| `user_feed_deliveries` | the join that puts a video in a user's feed on a given day, with watch state |
| `user_streaks` | current and longest streak per user |
| `subscription_tiers` | what a plan unlocks |
| `profiles` | user profile, including the plan they are on |

`src/lib/database.types.ts` is **generated** by
`supabase gen types typescript --local`. Do not hand-write a `Database` or
`Tables` interface beside it. A hand-written one omits the `Relationships`
key that postgrest's `GenericTable` requires, which silently collapses
every row to `never` — and the compiler reports that only at the call
sites, never at the definition.

A lesson is **narration plus slides**, not a rendered MP4. Two columns on
`generated_videos` carry names that predate that change and were kept
rather than migrated:

- `video_storage_path` holds the **`.wav` narration** — it means "the
  asset the player loads".
- `ai_metadata` carries the slide manifest (`{sequence, startSecond,
  endSecond, storagePath, onScreenHook}[]`) alongside the palette,
  scenes, and the model ids used. The player reads it as one blob, so a
  column per field would be a migration for nothing.

Row-level security is on. Client-side reads go through the anon key and
are constrained by policy; anything that must bypass RLS uses a service
role client and belongs on the server only.

Both storage buckets — `learning-videos` and `learning-thumbnails` — are
**private**. Reads go through `createSignedUrl`, not `getPublicUrl`:
`getPublicUrl` is a string builder that never contacts the server, so
against a private bucket it returns a URL that 404s without throwing.
The assets simply do not appear and nothing reports why.
`learning-videos` holds the narration *and* the slides, so its MIME
allowlist covers `audio/wav` and `image/*` as well as the legacy video
types.

## The Supabase clients

Picking the wrong one is the most common mistake in this codebase.

| Module | Runs in | Key | Use for |
| --- | --- | --- | --- |
| `src/lib/supabase/server.ts` | server components, route handlers | anon + user session | rendering a page as the signed-in user |
| `src/lib/supabase/client.ts` | client components | anon | runtime queries in the browser, e.g. feed pagination |
| `src/lib/supabase/admin.ts` | server only | **service role** | webhook reconciliation, cron dispatch, the dev bypass |
| `src/lib/supabase/service.ts` | server only | **service role** | the Inngest pipeline, and nothing else |

`service.ts` and `admin.ts` are the same client written twice — both
export a memoised `getSupabaseAdmin()` over `SUPABASE_SERVICE_ROLE_KEY`.
Two tickets built one independently of the other; only
`src/app/api/inngest/route.ts` imports `service.ts`. They are listed
separately here because the duplication is real and you will meet it, not
because the distinction means anything. Collapsing them is safe.

`src/lib/supabase/middleware.ts` refreshes the auth session on each
request. It is called from `src/middleware.ts`, the Next convention file
the framework loads by name — nothing imports `src/middleware.ts` itself,
and nothing should.

## Request paths

### `GET /` — the feed

`src/app/page.tsx` is a server component:

1. reads the session; no user renders `DailyDropLockedCard`
2. loads the profile and computes entitlements
3. locked renders `DailyDropLockedCard` with the next drop hour
4. unlocked loads today's deliveries and streak, renders `FeedContainer`

In development, step 1 falls through to `DEV_BYPASS_USER_ID` when there
is no session — see [DEVELOPMENT.md](DEVELOPMENT.md#running-without-auth).

Storage paths are turned into signed URLs here, on the server, before
anything reaches the browser: the narration, the thumbnail, and every
slide in the manifest.

`FeedContainer` renders `FeedScroller`, which renders one
`VideoPlayerItem` per delivery, calls `useFeedPrefetch` to warm upcoming
lessons, and pages in more deliveries with the **browser** client as the
user scrolls. `VideoPlayerItem` plays the narration over the slides (see
[Playback](#playback)) and reports progress through
`src/lib/telemetry/video-beacon.ts`. Completing a watch extends the
streak and can raise `HabitCelebrationModal`.

### `POST /api/inngest`

Hosts the three background functions. See below.

### `POST /api/webhooks/stripe`

Verifies the signature with `STRIPE_WEBHOOK_SECRET`, then reconciles
subscription state through `src/lib/billing/stripe-sync.ts` using the
admin client. Webhooks arrive without a user session, which is why this
path is service-role.

### `GET /api/cron/dispatch-daily-drops`

Authorised by `CRON_SECRET`, not by a user session. Triggers the daily
distribution and the push notifications in
`src/lib/notifications/dispatcher.ts`.

## The generation pipeline

`src/app/api/inngest/route.ts` defines three functions on the Inngest v4
client from `src/lib/inngest/client.ts`.

**`schedule-daily-video-generation`** — cron. Fetches active professions,
picks a topic for each, inserts a `generated_videos` row in `pending`, and
emits one generate event per profession.

**`microlearn-video-generation-pipeline`** — the work, one durable step
each so a failure resumes rather than restarts:

| Step | Does |
| --- | --- |
| `set-status-scripting` | marks the row in progress |
| `generate-script-gemini` | `src/lib/ai/script-generator.ts`, `gemini-3.7-flash` |
| `synthesize-audio-gemini-tts` | `src/lib/ai/tts-alignment.ts`; uploads the `.wav` to `narration/<slug>/<id>.wav` |
| `generate-slides` | `src/lib/ai/slide-generator.ts`, one image per scene, to `slides/<slug>/<id>/<n>.png` |
| `ingest-assets-to-supabase` | records the paths and the slide manifest; nothing is fetched or re-uploaded |
| `distribute-feed-deliveries` | a `user_feed_deliveries` row per eligible subscriber |

**`handle-pipeline-failure`** — marks the video row failed with the error,
so a stuck generation is visible instead of silently absent.

### Why slides and not generated video

`gemini-omni-1.1-flash` will generate real footage, and it bills about
**$0.10 per second of 720p video** — roughly **$6.00** for a single
60-second lesson, against about **$0.32** for eight slides plus
narration. At four professions a day that is the difference between
~$720 and ~$39 a month. A talking diagram does not need generated video,
so the pipeline draws one image per script beat and cross-fades them over
the voice.

### Narration is the clock

`synthesizeSpeechWithAlignment` returns the audio, its **measured**
duration, and word timings. `buildSlideManifest` scales every cue point
to that measured duration rather than to the script's own scene
boundaries: the script proposes a pace, TTS is what actually happened,
and the slides have to follow the voice.

Two details of `gemini-3.1-flash-tts-preview` are load-bearing. It
returns **raw PCM** (`audio/l16; rate=24000`), which `pcmToWav()` wraps
in a RIFF header — the browser will not play the bare payload. And the
alignment call is handed the **original script text**, not just the
audio; without it the aligner transcribes what it hears and drifts
("sixty" where the script said "60-second"), so the word timings stop
matching the captions.

If alignment fails, `proportionalAlignment()` distributes timings by word
length. Degraded cues beat no lesson.

## Playback

`VideoPlayerItem` mounts a `<video>` for the narration and every slide as
an absolutely-positioned `next/image`, opacity-switched on `currentTime`
against the manifest's cue points. All slides stay mounted — swapping
`src` would re-fetch and flash. If `currentTime` falls outside every cue
(the audio ran slightly long), it holds the nearest slide rather than
showing black.

`hls.js` is still wired up but is now the **fallback** path: the player
only reaches for it when the source URL ends in `.m3u8`. Handing hls.js a
plain `.wav` makes it fail where the browser would simply have played the
file, so a non-manifest URL is assigned straight to `videoEl.src`.

Inngest here is **v4**: `createFunction` takes two arguments and the
trigger goes inside the config object as `triggers`. The three-argument v3
form does not compile.

## Billing

`src/lib/billing/entitlements.ts` is pure: `calculateEntitlements` maps a
plan and status to what is unlocked, with no I/O. That is what makes it
the one thing under unit test. The gating decision in `page.tsx` calls it;
`src/lib/actions/billing.ts` is the server action behind the upgrade
control; `src/lib/billing/stripe-sync.ts` writes subscription state back
from webhooks.

## Boundaries worth keeping

- **Server actions mutate; client components do not write directly.**
  `src/lib/actions/feed.ts` owns watch progress and bookmarks.
- **The service role key never reaches the browser.** Only `admin.ts` and
  route handlers touch it. Anything prefixed `NEXT_PUBLIC_` is public.
- **Entitlement decisions happen on the server.** The client renders what
  it is handed; it does not decide what is unlocked.
- **Generated types are generated.** Re-run `supabase gen types` after a
  migration instead of editing `database.types.ts`.
