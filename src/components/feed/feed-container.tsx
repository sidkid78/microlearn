'use client';

import type { DeliveryWithVideo } from '../../lib/types/feed';
import { FeedScroller } from './feed-scroller';

interface FeedContainerProps {
  initialDeliveries: DeliveryWithVideo[];
  streak: { current_streak: number; longest_streak: number } | null;
  userId: string;
}

export function FeedContainer({ initialDeliveries, streak, userId }: FeedContainerProps) {
  return (
    <FeedScroller
      deliveries={initialDeliveries}
      streak={streak}
      userId={userId}
    />
  );
}
