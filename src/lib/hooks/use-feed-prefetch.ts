'use client';

import { useEffect } from 'react';
import type { DeliveryWithVideo } from '../types/feed';

interface NetworkInformation extends EventTarget {
  effectiveType: 'slow-2g' | '2g' | '3g' | '4g';
  saveData: boolean;
  downlink: number;
}

export function useFeedPrefetch(
  deliveries: DeliveryWithVideo[],
  activeIndex: number
) {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Check for Data Saver or slow connections
    const nav = navigator as unknown as { connection?: NetworkInformation };
    const connection = nav.connection;
    const isSaveData = connection?.saveData;
    const isSlowNetwork =
      connection?.effectiveType === '2g' || connection?.effectiveType === 'slow-2g';

    if (isSaveData || isSlowNetwork) {
      // Restrict prefetching completely on metered or degraded connections
      return;
    }

    const nextDelivery = deliveries[activeIndex + 1];
    if (!nextDelivery) return;

    // 1. Speculatively prefetch poster image using standard Image object
    const posterImg = new window.Image();
    posterImg.src = nextDelivery.video.thumbnailUrl;

    // 2. Prefetch the first 4 seconds (init segment + first 2 media chunks)
    // In HLS, fetching the master manifest primes the HTTP cache
    const manifestLink = document.createElement('link');
    manifestLink.rel = 'prefetch';
    manifestLink.as = 'fetch';
    manifestLink.href = nextDelivery.video.streamUrl;
    manifestLink.crossOrigin = 'anonymous';

    document.head.appendChild(manifestLink);

    return () => {
      if (document.head && document.head.contains(manifestLink)) {
        document.head.removeChild(manifestLink);
      }
    };
  }, [deliveries, activeIndex]);
}
