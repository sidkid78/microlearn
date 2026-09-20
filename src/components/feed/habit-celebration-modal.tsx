'use client';

import React, { useEffect } from 'react';
// @ts-expect-error canvas-confetti does not include type definitions
import rawConfetti from 'canvas-confetti';
import { Flame, CheckCircle2, ArrowRight, Trophy } from 'lucide-react';

interface ConfettiOptions {
  particleCount?: number;
  angle?: number;
  spread?: number;
  origin?: { x?: number; y?: number };
  colors?: string[];
}

type ConfettiFunction = (options?: ConfettiOptions) => Promise<null> | null;

const confetti = rawConfetti as unknown as ConfettiFunction;

interface HabitCelebrationModalProps {
  onClose: () => void;
  videoTitle: string;
}

export function HabitCelebrationModal({ onClose, videoTitle }: HabitCelebrationModalProps) {
  useEffect(() => {
    // Trigger dual-cannister confetti cannon
    const end = Date.now() + 1.2 * 1000;
    const colors = ['#f59e0b', '#10b981', '#3b82f6'];
    let animationFrameId: number;

    const frame = () => {
      confetti({
        particleCount: 3,
        angle: 60,
        spread: 55,
        origin: { x: 0, y: 0.8 },
        colors: colors,
      });
      confetti({
        particleCount: 3,
        angle: 120,
        spread: 55,
        origin: { x: 1, y: 0.8 },
        colors: colors,
      });

      if (Date.now() < end) {
        animationFrameId = requestAnimationFrame(frame);
      }
    };

    frame();

    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-sm rounded-3xl bg-neutral-900 border border-white/10 p-6 shadow-2xl text-center flex flex-col items-center">
        {/* Glow Halo */}
        <div className="absolute -top-12 h-24 w-24 rounded-full bg-amber-500/20 blur-2xl pointer-events-none" />

        {/* Milestone Icon */}
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-amber-500 to-orange-500 flex items-center justify-center shadow-lg shadow-amber-500/30 mb-4 scale-110 animate-pulse">
          <Flame className="w-9 h-9 text-white fill-white" />
        </div>

        <span className="px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-bold uppercase tracking-wider mb-2">
          Daily Drop Completed
        </span>

        <h3 className="text-xl font-extrabold text-white leading-tight mb-1">
          Skill Unlocked!
        </h3>
        <p className="text-neutral-400 text-xs line-clamp-1 mb-6">
          &quot;{videoTitle}&quot;
        </p>

        {/* Gamified Metric Box */}
        <div className="w-full bg-black/40 rounded-2xl border border-white/5 p-4 mb-6 flex items-center justify-around">
          <div className="flex flex-col items-center">
            <span className="text-[10px] text-neutral-400 uppercase font-semibold">Streak Added</span>
            <div className="flex items-center gap-1 text-emerald-400 font-bold text-lg">
              <CheckCircle2 className="w-4 h-4" />
              <span>+1 Day</span>
            </div>
          </div>
          <div className="h-8 w-px bg-white/10" />
          <div className="flex flex-col items-center">
            <span className="text-[10px] text-neutral-400 uppercase font-semibold">Solopreneur Rank</span>
            <div className="flex items-center gap-1 text-amber-400 font-bold text-lg">
              <Trophy className="w-4 h-4" />
              <span>Top 5%</span>
            </div>
          </div>
        </div>

        {/* Continue CTA */}
        <button
          onClick={onClose}
          className="w-full py-3.5 px-4 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 text-white font-semibold text-sm shadow-lg shadow-orange-500/25 active:scale-98 transition-transform flex items-center justify-center gap-2"
        >
          <span>Keep Scrolling</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
