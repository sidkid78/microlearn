'use client';

import React, { useState, useEffect } from 'react';
import { Lock, Clock, Sparkles } from 'lucide-react';

interface DailyDropLockedProps {
  deliveryHourUtc: number;
}

export function DailyDropLockedCard({ deliveryHourUtc }: DailyDropLockedProps) {
  const [timeLeft, setTimeLeft] = useState<string>('');

  useEffect(() => {
    const calculateTime = () => {
      const now = new Date();
      const nextDrop = new Date();
      nextDrop.setUTCHours(deliveryHourUtc, 0, 0, 0);

      if (now.getTime() >= nextDrop.getTime()) {
        nextDrop.setUTCDate(nextDrop.getUTCDate() + 1);
      }

      const diffMs = nextDrop.getTime() - now.getTime();
      const hours = Math.floor(diffMs / (1000 * 60 * 60));
      const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);

      setTimeLeft(
        `${hours.toString().padStart(2, '0')}:${minutes
          .toString()
          .padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
      );
    };

    calculateTime();
    const interval = setInterval(calculateTime, 1000);
    return () => clearInterval(interval);
  }, [deliveryHourUtc]);

  return (
    <div className="w-full h-[100dvh] bg-neutral-950 flex flex-col items-center justify-center p-6 text-center">
      <div className="w-20 h-20 rounded-3xl bg-neutral-900 border border-white/10 flex items-center justify-center text-amber-500 mb-6 shadow-2xl">
        <Lock className="w-10 h-10 stroke-[1.5]" />
      </div>

      <h2 className="text-white text-2xl font-black mb-2">
        You&apos;re All Caught Up!
      </h2>
      <p className="text-neutral-400 text-sm max-w-xs mb-8">
        Your next AI-synthesized micro-lesson drops in:
      </p>

      {/* Countdown Timer */}
      <div className="flex items-center gap-2 bg-neutral-900 border border-neutral-800 px-6 py-3 rounded-2xl text-amber-400 font-mono text-2xl font-bold tracking-widest mb-8">
        <Clock className="w-5 h-5 text-neutral-500" />
        <span>{timeLeft || '--:--:--'}</span>
      </div>

      <button className="px-6 py-3 rounded-xl bg-neutral-800 hover:bg-neutral-700 border border-white/10 text-white text-xs font-semibold flex items-center gap-2 transition-all">
        <Sparkles className="w-4 h-4 text-amber-400" />
        <span>Upgrade to Pro for Unlimited Feed Access</span>
      </button>
    </div>
  );
}
