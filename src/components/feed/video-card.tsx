'use client';

import { useRef, useEffect, useState, useTransition } from 'react';
import type { DeliveryWithVideo } from '../../lib/types/feed';
import { recordWatchProgress } from '../../lib/actions/feed';
import { VideoActions } from './video-actions';

function VideoOverlay({ title, topic, script }: { title: string; topic: { category: string } | null; script: string }) {
  return (
    <div className="absolute bottom-24 left-4 z-20 flex flex-col gap-2 max-w-[70%] text-white pointer-events-none">
      {topic && (
        <span className="bg-black/50 backdrop-blur-md px-2 py-1 rounded-md text-[10px] font-semibold w-fit border border-white/10">
          {topic.category}
        </span>
      )}
      <h2 className="text-lg font-bold leading-tight drop-shadow-md">{title}</h2>
      <p className="text-xs text-neutral-300 line-clamp-2 drop-shadow-md">{script}</p>
    </div>
  );
}

function CompletionCelebration({ onDismiss }: { onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 3000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
      <div className="animate-bounce bg-emerald-500/90 text-white px-6 py-3 rounded-full font-bold shadow-xl border border-white/20 backdrop-blur-sm">
        Daily Goal Met!
      </div>
    </div>
  );
}

interface VideoCardProps {
  delivery: DeliveryWithVideo;
  isActive: boolean;
  isPreloadTarget: boolean;
  userId: string;
}

export function VideoCard({ delivery, isActive, isPreloadTarget }: VideoCardProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [completed, setCompleted] = useState(delivery.is_completed);
  const [, setDurationWatched] = useState(Number(delivery.watch_duration_seconds));
  const [showCelebration, setShowCelebration] = useState(false);
  const [, startTransition] = useTransition();

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isActive) {
      video.play().catch((err) => {
        console.warn('Autoplay restricted, retrying muted:', err);
        video.muted = true;
        video.play().catch(() => {});
      });
    } else {
      video.pause();
    }
  }, [isActive]);

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;

    const currentSeconds = video.currentTime;
    setDurationWatched(currentSeconds);

    if (!completed && currentSeconds >= 50.0) {
      setCompleted(true);
      setShowCelebration(true);
      
      startTransition(async () => {
        await recordWatchProgress({
          deliveryId: delivery.id,
          watchedSeconds: currentSeconds,
          completed: true,
        });
      });
    }
  };

  useEffect(() => {
    return () => {
      if (videoRef.current && videoRef.current.currentTime > 5) {
        recordWatchProgress({
          deliveryId: delivery.id,
          watchedSeconds: videoRef.current.currentTime,
          completed: videoRef.current.currentTime >= 50.0,
        });
      }
    };
  }, [delivery.id]);

  return (
    <div className="relative h-full w-full overflow-hidden select-none bg-black">
      <video
        ref={videoRef}
        src={delivery.video.streamUrl}
        poster={delivery.video.thumbnailUrl}
        preload={isPreloadTarget ? 'auto' : 'none'}
        playsInline
        loop
        className="h-full w-full object-cover"
        onTimeUpdate={handleTimeUpdate}
      />

      <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-transparent to-black/80 pointer-events-none" />

      {showCelebration && (
        <CompletionCelebration onDismiss={() => setShowCelebration(false)} />
      )}

      <VideoOverlay
        title={delivery.video.title}
        topic={delivery.video.topic}
        script={delivery.video.script}
      />

      <VideoActions
        deliveryId={delivery.id}
        initialCompleted={completed}
        watchDuration={Number(delivery.watch_duration_seconds || 0)}
      />
    </div>
  );
}
