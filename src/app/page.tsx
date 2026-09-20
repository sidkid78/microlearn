import { createClient } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { FeedContainer } from '@/components/feed/feed-container';
import { DailyDropLockedCard } from '@/components/feed/daily-drop-locked-card';
import { checkUserEntitlements } from '@/lib/billing/entitlements';
import type { DeliveryWithVideo } from '@/lib/types/feed';

export default async function Home() {
  const sessionClient = await createClient();

  const {
    data: { user },
  } = await sessionClient.auth.getUser();

  // Local development only: adopt a seeded user instead of signing in.
  //
  // There is no auth UI in this project yet, so the home page can only
  // ever render its locked state — which makes the feed impossible to
  // look at while building it. `npm run seed:dev` creates a real user
  // with a real profile, entitlement and deliveries, and this adopts
  // that id.
  //
  // It is NOT a way around the entitlement check: everything below still
  // runs, so a seeded user on a tier without access still sees the
  // locked card. The only thing skipped is proving who you are.
  //
  // Two conditions, both required, so this cannot reach production:
  // NODE_ENV is `production` in any real deployment, and the variable
  // lives in .env.local, which is gitignored.
  const devUserId =
    process.env.NODE_ENV !== 'production' ? process.env.DEV_BYPASS_USER_ID : undefined;

  if (!user && !devUserId) {
    return <DailyDropLockedCard deliveryHourUtc={12} />;
  }

  const userId = user?.id ?? (devUserId as string);

  // Skipping auth is not enough on its own: every query below runs
  // through RLS, which correctly denies an unauthenticated request. So
  // the bypass path reads with the service-role client — the same one
  // the webhooks and the pipeline already use — while a real session
  // keeps using the session client and stays subject to RLS.
  const supabase = user ? sessionClient : getSupabaseAdmin();

  // Check user entitlements before proceeding with expensive feed data fetching
  const entitlements = await checkUserEntitlements(userId, supabase);

  // Fetch profile to get deliveryHourUtc for fallback or gating UI
  const { data: profile } = await supabase
    .from('profiles')
    .select('delivery_hour_utc')
    .eq('id', userId)
    .single();

  const deliveryHourUtc = profile?.delivery_hour_utc ?? 12;

  // Gate content if entitlement check fails
  if (!entitlements.canAccessDailyFeed) {
    return <DailyDropLockedCard deliveryHourUtc={deliveryHourUtc} />;
  }

  // Fetch streak
  const { data: streak } = await supabase
    .from('user_streaks')
    .select('current_streak, longest_streak')
    .eq('user_id', userId)
    .single();

  // Fetch deliveries with videos and topics
  const { data: deliveriesData } = await supabase
    .from('user_feed_deliveries')
    .select(`
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
    `)
    .eq('user_id', userId)
    .order('scheduled_for', { ascending: false });

  if (!deliveriesData || deliveriesData.length === 0) {
    return <DailyDropLockedCard deliveryHourUtc={deliveryHourUtc} />;
  }

  // Transform data to match DeliveryWithVideo interface
  // Both storage buckets are PRIVATE, so getPublicUrl returns a URL that
  // 404s without throwing — the assets simply never appear and nothing
  // reports why. Signed URLs are the correct read path here.
  //
  // The bucket names are `learning-videos` and `learning-thumbnails`;
  // the earlier code asked for `videos` and `thumbnails`, which do not
  // exist, and getPublicUrl happily built URLs for them anyway.
  const VIDEOS = 'learning-videos';
  const THUMBS = 'learning-thumbnails';
  const TTL = 60 * 60; // one hour, comfortably longer than a session

  async function signed(bucket: string, path: string | null | undefined): Promise<string> {
    if (!path) return '';
    const { data } = await supabase.storage.from(bucket).createSignedUrl(path, TTL);
    return data?.signedUrl ?? '';
  }

  const initialDeliveries: DeliveryWithVideo[] = await Promise.all(
    deliveriesData.map(async (d: any) => {
      const [streamUrl, thumbnailUrl] = await Promise.all([
        signed(VIDEOS, d.video?.video_storage_path),
        signed(THUMBS, d.video?.thumbnail_storage_path),
      ]);

      // Slide cue points ride in ai_metadata: the schema predates slides,
      // and adding a column would mean a migration for something the
      // player reads as one blob anyway.
      const meta = (d.video?.ai_metadata ?? {}) as {
        slides?: Array<{
          sequence: number;
          startSecond: number;
          endSecond: number;
          storagePath: string;
          onScreenHook: string;
        }>;
      };
      const slides = await Promise.all(
        (meta.slides ?? []).map(async (slide) => ({
          sequence: slide.sequence,
          startSecond: slide.startSecond,
          endSecond: slide.endSecond,
          url: await signed(VIDEOS, slide.storagePath),
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

  return (
    <main className="h-screen w-full bg-black overflow-hidden">
      <FeedContainer
        initialDeliveries={initialDeliveries}
        streak={streak}
        userId={userId}
      />
    </main>
  );
}
