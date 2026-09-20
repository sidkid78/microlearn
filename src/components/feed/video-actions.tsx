'use client';

import { useOptimistic, useTransition } from 'react';
import { Bookmark, CheckCircle2, Share2 } from 'lucide-react';
import { toggleBookmarkAction } from '../../lib/actions/feed';

interface VideoActionsProps {
  deliveryId: string;
  initialCompleted: boolean;
  watchDuration: number;
}

interface InteractionState {
  bookmarked: boolean;
}

export function VideoActions({
  deliveryId,
  initialCompleted,
}: VideoActionsProps) {
  const [, startTransition] = useTransition();

  const [optimisticState, setOptimisticState] = useOptimistic(
    { bookmarked: false },
    (state, update: Partial<InteractionState>) => ({
      ...state,
      ...update,
    })
  );

  const handleBookmarkToggle = () => {
    const nextState = !optimisticState.bookmarked;

    startTransition(async () => {
      setOptimisticState({ bookmarked: nextState });

      const result = await toggleBookmarkAction({
        deliveryId,
        bookmarked: nextState,
      });

      if (!result.success) {
        setOptimisticState({ bookmarked: !nextState });
      }
    });
  };

  return (
    <aside className="absolute right-4 bottom-24 z-20 flex flex-col items-center gap-6 text-white">
      <div className="flex flex-col items-center gap-1">
        <div
          className={`flex h-11 w-11 items-center justify-center rounded-full backdrop-blur-md transition-colors ${
            initialCompleted
              ? 'bg-emerald-500/80 text-white shadow-lg shadow-emerald-500/30'
              : 'bg-black/40 text-neutral-400 border border-white/10'
          }`}
        >
          <CheckCircle2 className="h-6 w-6" />
        </div>
        <span className="text-[10px] font-medium tracking-tight">
          {initialCompleted ? 'Completed' : '60s Goal'}
        </span>
      </div>

      <div className="flex flex-col items-center gap-1">
        <button
          onClick={handleBookmarkToggle}
          className={`flex h-11 w-11 items-center justify-center rounded-full backdrop-blur-md transition-transform active:scale-90 border border-white/10 ${
            optimisticState.bookmarked
              ? 'bg-amber-500 text-white shadow-lg shadow-amber-500/30'
              : 'bg-black/40 text-white hover:bg-black/60'
          }`}
          aria-label="Bookmark this micro-lesson"
        >
          <Bookmark
            className={`h-5 w-5 transition-transform ${
              optimisticState.bookmarked ? 'fill-current scale-110' : ''
            }`}
          />
        </button>
        <span className="text-[10px] font-medium tracking-tight">Save</span>
      </div>

      <div className="flex flex-col items-center gap-1">
        <button
          onClick={() => {
            if (navigator.share) {
              navigator.share({
                title: 'MicroLearn Pro Lesson',
                text: 'Master this skill in 60 seconds:',
                url: window.location.href,
              }).catch(() => {});
            }
          }}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-black/40 backdrop-blur-md border border-white/10 text-white hover:bg-black/60 transition-transform active:scale-90"
          aria-label="Share Lesson"
        >
          <Share2 className="h-5 w-5" />
        </button>
        <span className="text-[10px] font-medium tracking-tight">Share</span>
      </div>
    </aside>
  );
}
