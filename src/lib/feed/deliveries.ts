import type { SupabaseClient } from '@supabase/supabase-js';
import type { DeliveryWithVideo, SlideCue } from '@/lib/types/feed';

/**
 * Turning a delivery row into something the player can render.
 *
 * This lives in one module because it was previously written twice —
 * once in `src/app/page.tsx` for the first batch and once in
 * `feed-scroller.tsx` for everything after it — and the two drifted.
 * The server copy was fixed to sign private-bucket URLs; the client
 * copy was not, so scrolling past the first five lessons produced a
 * black player with no audio and no slides, reporting nothing.
 *
 * Three ways that second copy was wrong, all of them silent:
 *
 *   1. `getPublicUrl` on a PRIVATE bucket. It is a string builder that
 *      never contacts the server, so it cheerfully returns a URL that
 *      404s. No error, no throw, no log.
 *   2. Bucket names `videos` and `thumbnails`, which do not exist. The
 *      buckets are `learning-videos` and `learning-thumbnails` — and
 *      again, getPublicUrl does not care whether the bucket is real.
 *   3. Signing from the browser at all. Under the dev bypass there is
 *      no browser session, so storage RLS denies the request and
 *      pagination returns nothing.
 *
 * So the mapping is server-side, once, and both callers use it.
 */

/** Narration AND slides live here. `learning-thumbnails` is unused. */
const VIDEOS = 'learning-videos';

/** One hour, comfortably longer than a viewing session. */
const TTL = 60 * 60;

/**
 * Every column the player needs, including `ai_metadata` — the slide
 * manifest rides in it. Shared so a caller cannot fetch a row that is
 * missing a field the mapper reads.
 */
export const DELIVERY_SELECT = `
  id,
  scheduled_for,
  status,
  watched_at,
  watch_duration_seconds,
  is_completed,
  video:generated_videos (
    id,
    title,
    script,
    captions,
    ai_metadata,
    video_storage_path,
    thumbnail_storage_path,
    duration_seconds,
    topic:topics (
      title,
      category,
      difficulty_level
    )
  )
` as const;

interface StoredSlide {
  sequence: number;
  startSecond: number;
  endSecond: number;
  storagePath: string;
  onScreenHook: string;
}

export async function signDeliveries(
  supabase: SupabaseClient<never>,
  rows: unknown[]
): Promise<DeliveryWithVideo[]> {
  async function signed(path: string | null | undefined): Promise<string> {
    // The pipeline writes the literal string "pending" before the assets
    // exist. Signing it would produce a URL for an object that is not
    // there yet, so it is treated as absent.
    if (!path || path === 'pending') return '';
    const { data } = await supabase.storage.from(VIDEOS).createSignedUrl(path, TTL);
    return data?.signedUrl ?? '';
  }

  return Promise.all(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rows as any[]).map(async (d): Promise<DeliveryWithVideo> => {
      // The poster is slide 1, which the pipeline uploads alongside the
      // other slides — so it is in `learning-videos`, despite the column
      // being called thumbnail_storage_path and a `learning-thumbnails`
      // bucket existing. Signing it against that bucket, as the first
      // version did, always returned an empty URL.
      const [streamUrl, thumbnailUrl] = await Promise.all([
        signed(d.video?.video_storage_path),
        signed(d.video?.thumbnail_storage_path),
      ]);

      // Slide cue points ride in ai_metadata: the schema predates slides,
      // and adding a column would mean a migration for something the
      // player reads as one blob anyway.
      const meta = (d.video?.ai_metadata ?? {}) as { slides?: StoredSlide[] };
      const slides: SlideCue[] = await Promise.all(
        (meta.slides ?? []).map(async (slide) => ({
          sequence: slide.sequence,
          startSecond: slide.startSecond,
          endSecond: slide.endSecond,
          url: await signed(slide.storagePath),
          onScreenHook: slide.onScreenHook,
        }))
      );

      return {
        id: d.id,
        scheduled_for: d.scheduled_for,
        status: d.status,
        watched_at: d.watched_at,
        watch_duration_seconds: d.watch_duration_seconds,
        is_completed: !!d.is_completed,
        video: {
          id: d.video.id,
          title: d.video.title,
          script: d.video.script,
          captions: d.video.captions,
          video_storage_path: d.video.video_storage_path,
          thumbnail_storage_path: d.video.thumbnail_storage_path,
          duration_seconds: d.video.duration_seconds,
          streamUrl,
          thumbnailUrl,
          slides,
          topic: d.video.topic,
        },
      };
    })
  );
}
