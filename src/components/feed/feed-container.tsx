'use client';

import { useState, useRef, useEffect } from 'react';
import type { DeliveryWithVideo } from '../../lib/types/feed';
import { VideoCard } from './video-card';
import { Flame } from 'lucide-react';

interface FeedContainerProps {
  initialDeliveries: DeliveryWithVideo[];
  streak: { current_streak: number; longest_streak: number } | null;
  userId: string;
}

export function FeedContainer({ initialDeliveries, streak, userId }: FeedContainerProps) {
  const [deliveries] = useState<DeliveryWithVideo[]>(initialDeliveries);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const scrollPosition = container.scrollTop;
      const height = container.clientHeight;
      const newIndex = Math.round(scrollPosition / height);
      if (newIndex !== activeIndex && newIndex >= 0 && newIndex < deliveries.length) {
        setActiveIndex(newIndex);
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [activeIndex, deliveries.length]);

  return (
    <div className="relative h-full w-full">
      <header className="absolute top-4 left-4 z-30 flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 backdrop-blur-md border border-white/10 text-white text-xs font-semibold">
        <Flame className="w-4 h-4 text-orange-500 fill-orange-500 animate-pulse" />
        <span>{streak?.current_streak ?? 0} Day Streak</span>
      </header>

      <div
        ref={containerRef}
        className="h-full w-full overflow-y-scroll snap-y snap-mandatory no-scrollbar"
        style={{ scrollBehavior: 'smooth' }}
      >
        {deliveries.map((delivery, index) => (
          <section
            key={delivery.id}
            className="relative h-full w-full snap-start snap-always shrink-0 flex items-center justify-center bg-neutral-950"
          >
            <VideoCard
              delivery={delivery}
              isActive={index === activeIndex}
              isPreloadTarget={Math.abs(index - activeIndex) <= 1}
              userId={userId}
            />
          </section>
        ))}
      </div>
    </div>
  );
}
