import { createClient } from '@/lib/supabase/server';
import { FeedContainer } from '@/components/feed/feed-container';
import { DailyDropLockedCard } from '@/components/feed/daily-drop-locked-card';
import { checkUserEntitlements } from '@/lib/billing/entitlements';
import type { DeliveryWithVideo } from '@/lib/types/feed';

export default async function Home() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return <DailyDropLockedCard deliveryHourUtc={12} />;
  }

  const userId = user.id;

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
  const initialDeliveries: DeliveryWithVideo[] = deliveriesData.map((d: any) => {
    const videoPath = d.video?.video_storage_path;
    const thumbnailPath = d.video?.thumbnail_storage_path;

    const { data: { publicUrl: streamUrl } } = supabase.storage.from('videos').getPublicUrl(videoPath);
    const { data: { publicUrl: thumbnailUrl } } = supabase.storage.from('thumbnails').getPublicUrl(thumbnailPath);

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
        topic: d.video.topic
      }
    };
  });

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
