# Architecture

## Data model

Seven tables, defined in `supabase/migrations/0001_db_schema_rls.sql` and
typed in `src/lib/database.types.ts`.

| Table | Holds |
| --- | --- |
| `niche_professions` | the audiences content is produced for; the pipeline iterates the active ones |
| `topics` | per-profession subjects, with category and difficulty |
| `generated_videos` | one row per produced video: script, storage paths, `generation_status`, captions, AI metadata |
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

Row-level security is on. Client-side reads go through the anon key and
are constrained by policy; anything that must bypass RLS uses the service
role client in `src/lib/supabase/admin.ts` and belongs on the server only.

## The three Supabase clients

Picking the wrong one is the most common mistake in this codebase.

| Module | Runs in | Key | Use for |
| --- | --- | --- | --- |
| `src/lib/supabase/server.ts` | server components, route handlers | anon + user session | rendering a page as the signed-in user |
| `src/lib/supabase/client.ts` | client components | anon | runtime queries in the browser, e.g. feed pagination |
| `src/lib/supabase/admin.ts` | server only | **service role** | webhook reconciliation, pipeline writes |

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

`FeedContainer` renders `FeedScroller`, which renders one
`VideoPlayerItem` per delivery, calls `useFeedPrefetch` to warm upcoming
videos, and pages in more deliveries with the **browser** client as the
user scrolls. `VideoPlayerItem` streams via `hls.js` and reports progress
through `src/lib/telemetry/video-beacon.ts`. Completing a watch extends
the streak and can raise `HabitCelebrationModal`.

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
| `generate-script-gemini` | `src/lib/ai/script-generator.ts`, Gemini 3.7 Flash |
| `synthesize-audio-elevenlabs` | narration, plus word timings in `src/lib/ai/tts-alignment.ts` |
| `dispatch-remotion-render` | `src/lib/remotion/renderer.ts`, Remotion Lambda |
| `poll-render-completion` | waits for the render |
| `ingest-assets-to-supabase` | video and thumbnail into Storage |
| `distribute-feed-deliveries` | a `user_feed_deliveries` row per eligible subscriber |

**`handle-pipeline-failure`** — marks the video row failed with the error,
so a stuck generation is visible instead of silently absent.

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
