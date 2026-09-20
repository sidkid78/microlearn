'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { DeliveryWithVideo } from '../../lib/types/feed';
import { VideoPlayerItem } from './video-player-item';
import { useFeedPrefetch } from '../../lib/hooks/use-feed-prefetch';
import { Volume2, VolumeX, Flame } from 'lucide-react';

interface FeedScrollerProps {
  deliveries: DeliveryWithVideo[];
  streak: { current_streak: number; longest_streak: number } | null;
  userId: string;
}

export function FeedScroller({ deliveries, streak, userId }: FeedScrollerProps) {
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [isGlobalMuted, setIsGlobalMuted] = useState<boolean>(true);
  const containerRef = useRef<HTMLDivElement>(null);

  useFeedPrefetch(deliveries, activeIndex);

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
    if (index < 0 || index >= deliveries.length || !containerRef.current) return;
    const targetY = index * containerRef.current.clientHeight;
    containerRef.current.scrollTo({
      top: targetY,
      behavior: 'smooth',
    });
  }, [deliveries.length]);

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

    if (computedIndex !== activeIndex && computedIndex >= 0 && computedIndex < deliveries.length) {
      setActiveIndex(computedIndex);
    }
  }, [activeIndex, deliveries.length]);

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

        <button
          onClick={toggleGlobalMute}
          className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-white shadow-lg active:scale-95 transition-transform"
          aria-label={isGlobalMuted ? 'Unmute feed' : 'Mute feed'}
        >
          {isGlobalMuted ? (
            <VolumeX className="w-5 h-5 text-neutral-300" />
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
        {deliveries.map((delivery, index) => {
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
                onToggleMute={toggleGlobalMute}
                userId={userId}
              />
            </section>
          );
        })}
      </main>
    </div>
  );
}
