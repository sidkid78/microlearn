'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { DeliveryWithVideo } from '@/lib/types/feed';
import { VideoPlayerItem } from './video-player-item';
import { useFeedPrefetch } from '@/lib/hooks/use-feed-prefetch';
import { Volume2, VolumeX, Flame, Loader2 } from 'lucide-react';
import { loadMoreDeliveries as loadMoreDeliveriesAction } from '@/lib/actions/feed';

interface FeedScrollerProps {
  deliveries: DeliveryWithVideo[];
  streak: { current_streak: number; longest_streak: number } | null;
  userId: string;
}

const PAGE_SIZE = 5;

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

  // Pagination is a server action, not a browser query.
  //
  // The client cannot build these URLs: both buckets are private, so
  // the assets need signing, and signing needs a server. It also has no
  // session at all under the dev bypass. Asking the server for a page
  // of render-ready deliveries removes both problems and stops the
  // bucket names being written down in two places.
  const loadMoreDeliveries = useCallback(async () => {
    if (isLoadingRef.current || !hasMore || feedDeliveries.length === 0) return;

    isLoadingRef.current = true;
    setIsLoadingMore(true);

    try {
      const lastDelivery = feedDeliveries[feedDeliveries.length - 1];
      const result = await loadMoreDeliveriesAction({
        before: lastDelivery.scheduled_for,
        limit: PAGE_SIZE,
      });

      if (!result.success || !result.data) {
        console.error('Error fetching additional deliveries:', result.error);
        return;
      }

      const existingIds = new Set(feedDeliveries.map((d) => d.id));
      const fresh = result.data.filter((d) => !existingIds.has(d.id));

      if (fresh.length > 0) {
        setFeedDeliveries((prev) => [...prev, ...fresh]);
      }

      // Short page means the end. Measured against what the server
      // returned, not what survived de-duplication, or a page made
      // entirely of already-seen rows would look like the end of the feed.
      if (result.data.length < PAGE_SIZE) {
        setHasMore(false);
      }
    } catch (err) {
      console.error('Unexpected error loading more deliveries:', err);
    } finally {
      isLoadingRef.current = false;
      setIsLoadingMore(false);
    }
  }, [hasMore, feedDeliveries]);

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
