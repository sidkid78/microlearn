'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { DeliveryWithVideo } from '@/lib/types/feed';
import { VideoPlayerItem } from './video-player-item';
import { useFeedPrefetch } from '@/lib/hooks/use-feed-prefetch';
import { Volume2, VolumeX, Flame, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

interface FeedScrollerProps {
  deliveries: DeliveryWithVideo[];
  streak: { current_streak: number; longest_streak: number } | null;
  userId: string;
}

export function FeedScroller({ deliveries, streak, userId }: FeedScrollerProps) {
  const [feedDeliveries, setFeedDeliveries] = useState<DeliveryWithVideo[]>(deliveries);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [isGlobalMuted, setIsGlobalMuted] = useState<boolean>(true);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [hasMore, setHasMore] = useState<boolean>(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const isLoadingRef = useRef<boolean>(false);

  useFeedPrefetch(feedDeliveries, activeIndex);

  // Sync state if deliveries prop changes
  useEffect(() => {
    setFeedDeliveries(deliveries);
  }, [deliveries]);

  // Restore audio preference from session storage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedAudioState = sessionStorage.getItem('microlearn_audio_unlocked');
      if (savedAudioState === 'true') {
        setIsGlobalMuted(false);
      }
    }
  }, []);

  const toggleGlobalMute = useCallback(() => {
    setIsGlobalMuted((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('microlearn_audio_unlocked', String(!next));
      }
      return next;
    });
  }, []);

  const scrollToIndex = useCallback((index: number) => {
    if (index < 0 || index >= feedDeliveries.length || !containerRef.current) return;
    const targetY = index * containerRef.current.clientHeight;
    containerRef.current.scrollTo({
      top: targetY,
      behavior: 'smooth',
    });
  }, [feedDeliveries.length]);

  // Runtime pagination using the Supabase browser client
  const loadMoreDeliveries = useCallback(async () => {
    if (isLoadingRef.current || !hasMore || feedDeliveries.length === 0) return;

    isLoadingRef.current = true;
    setIsLoadingMore(true);

    try {
      const lastDelivery = feedDeliveries[feedDeliveries.length - 1];
      const supabase = createClient();

      const { data: deliveriesData, error } = await supabase
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
        .lt('scheduled_for', lastDelivery.scheduled_for)
        .order('scheduled_for', { ascending: false })
        .limit(5);

      if (error) {
        console.error('Error fetching additional deliveries:', error);
        return;
      }

      if (!deliveriesData || deliveriesData.length === 0) {
        setHasMore(false);
        return;
      }

      const existingIds = new Set(feedDeliveries.map((d) => d.id));
      const validItems = (deliveriesData as any[]).filter(
        (d) => d && d.video && !existingIds.has(d.id)
      );

      if (validItems.length === 0) {
        setHasMore(false);
        return;
      }

      const newDeliveries: DeliveryWithVideo[] = validItems.map((d: any) => {
        const videoPath = d.video?.video_storage_path;
        const thumbnailPath = d.video?.thumbnail_storage_path;

        const {
          data: { publicUrl: streamUrl },
        } = supabase.storage.from('videos').getPublicUrl(videoPath || '');
        const {
          data: { publicUrl: thumbnailUrl },
        } = supabase.storage.from('thumbnails').getPublicUrl(thumbnailPath || '');

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
            // Same shape the server component builds. Paginated pages
            // must carry slides too, or scrolling past the first batch
            // silently drops the visuals.
            slides: (((d.video as { ai_metadata?: { slides?: Array<{
              sequence: number; startSecond: number; endSecond: number;
              storagePath: string; onScreenHook: string;
            }> } }).ai_metadata?.slides) ?? []).map((slide) => ({
              sequence: slide.sequence,
              startSecond: slide.startSecond,
              endSecond: slide.endSecond,
              url: supabase.storage.from('videos').getPublicUrl(slide.storagePath).data.publicUrl,
              onScreenHook: slide.onScreenHook,
            })),
            topic: d.video.topic,
          },
        };
      });

      setFeedDeliveries((prev) => [...prev, ...newDeliveries]);
      if (deliveriesData.length < 5) {
        setHasMore(false);
      }
    } catch (err) {
      console.error('Unexpected error loading more deliveries:', err);
    } finally {
      isLoadingRef.current = false;
      setIsLoadingMore(false);
    }
  }, [hasMore, feedDeliveries, userId]);

  // Trigger pagination when user scrolls near the end of the loaded feed
  useEffect(() => {
    if (activeIndex >= feedDeliveries.length - 2 && hasMore && !isLoadingRef.current && feedDeliveries.length > 0) {
      loadMoreDeliveries();
    }
  }, [activeIndex, feedDeliveries.length, hasMore, loadMoreDeliveries]);

  // Keyboard navigation handler (Desktop / Tablet with keyboard)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['ArrowDown', 'j', 'J'].includes(e.key)) {
        e.preventDefault();
        scrollToIndex(activeIndex + 1);
      } else if (['ArrowUp', 'k', 'K'].includes(e.key)) {
        e.preventDefault();
        scrollToIndex(activeIndex - 1);
      } else if (['m', 'M'].includes(e.key)) {
        e.preventDefault();
        toggleGlobalMute();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeIndex, toggleGlobalMute, scrollToIndex]);

  // Viewport intersection observer to track active index
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const height = container.clientHeight;
    if (height === 0) return;

    const currentScroll = container.scrollTop;
    const computedIndex = Math.round(currentScroll / height);

    if (computedIndex !== activeIndex && computedIndex >= 0 && computedIndex < feedDeliveries.length) {
      setActiveIndex(computedIndex);
    }
  }, [activeIndex, feedDeliveries.length]);

  return (
    <div className="relative w-full h-[100dvh] bg-black overflow-hidden select-none">
      {/* HUD Header: Persistent Streak & Global Audio Toggle */}
      <header className="absolute top-4 inset-x-4 z-40 flex items-center justify-between pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-black/60 px-3.5 py-1.5 backdrop-blur-md border border-white/10 shadow-lg">
          <Flame className="w-4 h-4 text-amber-500 fill-amber-500 animate-pulse" />
          <span className="text-white text-xs font-semibold tracking-wide">
            {streak?.current_streak ?? 0} Day Streak
          </span>
        </div>

        {/* Muted is the browser's rule, not a preference: autoplay only
            works silent until the user interacts. That was survivable
            when a lesson was video — you could still watch it. A lesson
            is now narration over slides, so muted means NO content at
            all, just pictures with no explanation.
            So while muted the control says what it is instead of being a
            bare icon in a corner, and it goes quiet once sound is on. */}
        <button
          onClick={toggleGlobalMute}
          className={
            isGlobalMuted
              ? 'pointer-events-auto flex h-10 items-center gap-2 rounded-full bg-amber-500 px-4 text-sm font-bold text-black shadow-lg active:scale-95 transition-transform animate-pulse'
              : 'pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-white shadow-lg active:scale-95 transition-transform'
          }
          aria-label={isGlobalMuted ? 'Turn on sound' : 'Mute feed'}
        >
          {isGlobalMuted ? (
            <>
              <VolumeX className="w-5 h-5" />
              <span>Tap for sound</span>
            </>
          ) : (
            <Volume2 className="w-5 h-5 text-emerald-400" />
          )}
        </button>
      </header>

      {/* Snap Scroll Viewport */}
      <main
        ref={containerRef}
        onScroll={handleScroll}
        className="w-full h-full overflow-y-scroll snap-y snap-mandatory no-scrollbar"
        style={{ scrollBehavior: 'smooth', WebkitOverflowScrolling: 'touch' }}
      >
        {feedDeliveries.map((delivery, index) => {
          // Fixed 3-node sliding window: only render real video players within distance <= 1
          const shouldMountVideo = Math.abs(index - activeIndex) <= 1;

          return (
            <section
              key={delivery.id}
              className="relative w-full h-[100dvh] snap-start snap-always shrink-0 overflow-hidden bg-neutral-950 flex items-center justify-center"
            >
              <VideoPlayerItem
                delivery={delivery}
                isActive={index === activeIndex}
                shouldMountVideo={shouldMountVideo}
                isGlobalMuted={isGlobalMuted}
                userId={userId}
              />
            </section>
          );
        })}
      </main>

      {/* Subtle Loading Indicator for background pagination */}
      {isLoadingMore && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 rounded-full bg-black/70 px-3.5 py-1.5 backdrop-blur-md border border-white/10 shadow-lg pointer-events-none">
          <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />
          <span className="text-white/80 text-[11px] font-medium tracking-wide">
            Loading older drops...
          </span>
        </div>
      )}
    </div>
  );
}
