'use client';

import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import Image from 'next/image';
import Hls from 'hls.js';
import type { DeliveryWithVideo } from '../../lib/types/feed';
import { recordWatchProgress, toggleBookmarkAction } from '../../lib/actions/feed';
import { VideoTelemetryDispatcher } from '../../lib/telemetry/video-beacon';
import { Heart, Bookmark, Share2, Play, Check } from 'lucide-react';
import { HabitCelebrationModal } from './habit-celebration-modal';

interface WordCaption {
  word: string;
  start: number;
  end: number;
}

interface VideoPlayerItemProps {
  delivery: DeliveryWithVideo;
  isActive: boolean;
  shouldMountVideo: boolean;
  isGlobalMuted: boolean;
  userId: string;
}

export function VideoPlayerItem({
  delivery,
  isActive,
  shouldMountVideo,
  isGlobalMuted,
  userId,
}: VideoPlayerItemProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const telemetryRef = useRef<VideoTelemetryDispatcher | null>(null);

  // Playback States
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(60);
  const [isCompleted, setIsCompleted] = useState<boolean>(delivery.is_completed);
  const [showCelebration, setShowCelebration] = useState<boolean>(false);
  const [currentWord, setCurrentWord] = useState<string>('');
  const [showHeartAnim, setShowHeartAnim] = useState<boolean>(false);
  const [isBookmarked, setIsBookmarked] = useState<boolean>(false);

  // Gesture Tracker
  const lastTapRef = useRef<number>(0);
  const singleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The slide showing right now. A lesson is an audio track plus cue
  // points, so this is what used to be a frame of rendered video: the
  // switching happens here instead of in a render farm.
  const slides = delivery.video.slides ?? [];
  const activeSlide = useMemo(() => {
    if (slides.length === 0) return null;
    return (
      slides.find((s) => currentTime >= s.startSecond && currentTime < s.endSecond) ??
      // Before the first cue, or after the last one when the audio runs
      // slightly long, hold the nearest slide rather than showing black.
      (currentTime < slides[0].startSecond ? slides[0] : slides[slides.length - 1])
    );
  }, [slides, currentTime]);

  const captions: WordCaption[] = useMemo(() => {
    if (!delivery.video.captions) return [];
    const raw = delivery.video.captions as { words?: WordCaption[] };
    return Array.isArray(raw.words) ? raw.words : [];
  }, [delivery.video.captions]);

  // Telemetry session initialization and unmount flush
  useEffect(() => {
    telemetryRef.current = new VideoTelemetryDispatcher(delivery.id, userId);

    const handlePageHide = () => {
      if (videoRef.current) {
        const finalSec = videoRef.current.currentTime;
        telemetryRef.current?.flushOnExit(finalSec, finalSec >= 50.0);
      }
    };

    window.addEventListener('pagehide', handlePageHide);

    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      if (videoRef.current) {
        const finalSec = videoRef.current.currentTime;
        telemetryRef.current?.flushOnExit(finalSec, finalSec >= 50.0);
      }
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
      }
    };
  }, [delivery.id, userId]);

  // Clean Hls Instance
  const destroyHls = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
  }, []);

  // Initialize Adaptive Player (HLS.js or Native HLS)
  useEffect(() => {
    if (!shouldMountVideo) {
      destroyHls();
      return;
    }

    const videoEl = videoRef.current;
    if (!videoEl) return;

    const streamUrl = delivery.video.streamUrl;

    // Lessons are narration over slides now, so the source is usually a
    // .wav rather than an HLS manifest. hls.js cannot parse one, and
    // handing it a plain media file makes it fail where the browser
    // would simply have played it.
    if (!/\.m3u8(\?|$)/i.test(streamUrl)) {
      videoEl.src = streamUrl;
    } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      // Native Safari HLS
      videoEl.src = streamUrl;
    } else if (Hls.isSupported()) {
      // Media Source Extensions for Chrome / Edge / Firefox / Android
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 10,
        maxBufferLength: 20, // 20s max buffer to conserve memory
        maxMaxBufferLength: 30,
        startLevel: -1, // Auto ABR resolution selector
      });

      hls.loadSource(streamUrl);
      hls.attachMedia(videoEl);
      hlsRef.current = hls;

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              destroyHls();
              break;
          }
        }
      });
    } else {
      // Direct MP4 Fallback
      videoEl.src = streamUrl;
    }

    return () => {
      destroyHls();
    };
  }, [shouldMountVideo, delivery.video.streamUrl, destroyHls]);

  // Sync Global Mute with local element
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = isGlobalMuted;
    }
  }, [isGlobalMuted]);

  // Play / Pause orchestration based on Viewport State
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !shouldMountVideo) return;

    if (isActive) {
      const playPromise = video.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => setIsPlaying(true))
          .catch((err) => {
            console.warn('Autoplay prevented, fallback to muted:', err);
            video.muted = true;
            video.play().then(() => setIsPlaying(true)).catch(() => {});
          });
      }
    } else {
      video.pause();
      setIsPlaying(false);
    }
  }, [isActive, shouldMountVideo]);

  // High-Resolution Time Tracking & Caption Alignment
  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;

    const currentSec = video.currentTime;
    setCurrentTime(currentSec);

    // Dynamic word caption selection
    if (captions.length > 0) {
      const match = captions.find(
        (c) => currentSec >= c.start && currentSec <= c.end
      );
      setCurrentWord(match ? match.word : '');
    }

    // Telemetry tracking
    telemetryRef.current?.trackProgress(currentSec, isCompleted || currentSec >= 50.0);

    // Completion Milestone Trigger (50s threshold as specified in DB Schema)
    if (!isCompleted && currentSec >= 50.0) {
      setIsCompleted(true);
      setShowCelebration(true);

      recordWatchProgress({
        deliveryId: delivery.id,
        watchedSeconds: currentSec,
        completed: true,
      }).catch((err) => {
        console.error('Watch progress synchronization error:', err);
      });
    }
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration || 60);
    }
  };

  const togglePlayPause = () => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      video.play().then(() => setIsPlaying(true)).catch(() => {});
    } else {
      video.pause();
      setIsPlaying(false);
    }
  };

  const triggerHeartAnimation = () => {
    setShowHeartAnim(true);
    setIsBookmarked(true);
    toggleBookmarkAction({ deliveryId: delivery.id, bookmarked: true }).catch(() => {});
    setTimeout(() => setShowHeartAnim(false), 900);
  };

  // Touch Gesture Engine: Disambiguate Single-Tap (Play/Pause) vs Double-Tap (Heart)
  const handleScreenTouch = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    const now = Date.now();
    const DOUBLE_TAP_THRESHOLD = 280;

    if (now - lastTapRef.current < DOUBLE_TAP_THRESHOLD) {
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
        singleTapTimerRef.current = null;
      }
      triggerHeartAnimation();
      lastTapRef.current = 0;
    } else {
      lastTapRef.current = now;
      singleTapTimerRef.current = setTimeout(() => {
        togglePlayPause();
        singleTapTimerRef.current = null;
      }, DOUBLE_TAP_THRESHOLD);
    }
  };

  return (
    <div
      className="relative w-full h-full max-w-md mx-auto overflow-hidden bg-black select-none"
      onClick={handleScreenTouch}
    >
      {/* The lesson itself: slides cross-fading over the narration.
          The <video> element below still owns playback, progress and
          telemetry — it just has no picture, because the picture is
          these. Every slide is mounted and opacity-switched so the next
          one is already decoded when its cue arrives; swapping a single
          src flashes on slower connections. */}
      {slides.length > 0 && (
        <div className="absolute inset-0 bg-black">
          {slides.map((slide) => (
            <Image
              key={slide.sequence}
              src={slide.url}
              alt={slide.onScreenHook}
              fill
              sizes="100vw"
              priority={slide.sequence === slides[0].sequence}
              className={`object-cover transition-opacity duration-500 ${
                activeSlide?.sequence === slide.sequence ? 'opacity-100' : 'opacity-0'
              }`}
            />
          ))}
        </div>
      )}

      {/* Video Node vs Light Poster Placeholder (DOM Recycling) */}
      {shouldMountVideo ? (
        <video
          ref={videoRef}
          playsInline
          loop
          preload="auto"
          muted={isGlobalMuted}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          poster={delivery.video.thumbnailUrl}
          className={
            slides.length > 0
              ? 'absolute inset-0 w-full h-full opacity-0 pointer-events-none'
              : 'w-full h-full object-cover pointer-events-none'
          }
        />
      ) : (
        <div className="relative w-full h-full">
          <Image
            src={delivery.video.thumbnailUrl}
            alt={delivery.video.title}
            fill
            sizes="(max-width: 768px) 100vw, 448px"
            priority={false}
            className="object-cover"
          />
        </div>
      )}

      {/* Top and Bottom Contrast Gradients */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black/90 pointer-events-none" />

      {/* Play/Pause Center Transient HUD */}
      {!isPlaying && shouldMountVideo && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="h-16 w-16 rounded-full bg-black/50 backdrop-blur-md flex items-center justify-center border border-white/20 animate-in fade-in zoom-in-75">
            <Play className="w-8 h-8 text-white fill-white ml-1" />
          </div>
        </div>
      )}

      {/* Dynamic Animated Heart on Double Tap */}
      {showHeartAnim && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-50">
          <Heart className="w-24 h-24 text-rose-500 fill-rose-500 animate-bounce scale-125 duration-300 drop-shadow-[0_0_15px_rgba(244,63,94,0.6)]" />
        </div>
      )}

      {/* Dynamic Word Captions Bar */}
      {currentWord && (
        <div className="absolute bottom-32 inset-x-8 flex justify-center pointer-events-none z-30">
          <span className="bg-black/75 px-3.5 py-1.5 rounded-lg text-white font-black text-xl tracking-wide uppercase drop-shadow-md border border-white/10 transform scale-105 transition-transform">
            {currentWord}
          </span>
        </div>
      )}

      {/* Right Rail Interaction Column */}
      <aside className="absolute right-4 bottom-24 z-30 flex flex-col items-center gap-5">
        {/* Habit Completion Check Icon */}
        <div className="flex flex-col items-center gap-1">
          <div
            className={`w-11 h-11 rounded-full flex items-center justify-center border transition-all duration-300 backdrop-blur-md ${
              isCompleted
                ? 'bg-emerald-500 border-emerald-400 text-white shadow-[0_0_12px_rgba(16,185,129,0.5)]'
                : 'bg-black/40 border-white/20 text-neutral-400'
            }`}
          >
            <Check className="w-6 h-6 stroke-[2.5]" />
          </div>
          <span className="text-[10px] text-white/80 font-semibold tracking-wider">
            {isCompleted ? '100%' : 'GOAL'}
          </span>
        </div>

        {/* Bookmark Icon */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            const nextState = !isBookmarked;
            setIsBookmarked(nextState);
            toggleBookmarkAction({ deliveryId: delivery.id, bookmarked: nextState }).catch(() => {});
          }}
          className={`w-11 h-11 rounded-full flex items-center justify-center border backdrop-blur-md transition-transform active:scale-90 ${
            isBookmarked
              ? 'bg-amber-500 border-amber-400 text-white'
              : 'bg-black/40 border-white/20 text-white hover:bg-black/60'
          }`}
          aria-label="Save lesson"
        >
          <Bookmark className={`w-5 h-5 ${isBookmarked ? 'fill-white' : ''}`} />
        </button>

        {/* Native Share */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (typeof navigator !== 'undefined' && navigator.share) {
              navigator.share({
                title: delivery.video.title,
                text: `Learned this in 60 seconds on MicroLearn Pro: ${delivery.video.title}`,
                url: window.location.href,
              }).catch(() => {});
            }
          }}
          className="w-11 h-11 rounded-full bg-black/40 border border-white/20 flex items-center justify-center text-white backdrop-blur-md hover:bg-black/60 active:scale-90 transition-transform"
          aria-label="Share lesson"
        >
          <Share2 className="w-5 h-5" />
        </button>
      </aside>

      {/* Bottom Content Metadata Overlay */}
      <footer className="absolute bottom-6 inset-x-4 z-30 pointer-events-none">
        <div className="flex flex-col gap-2 max-w-[82%] pointer-events-auto">
          {delivery.video.topic && (
            <div className="self-start px-2.5 py-0.5 rounded-full bg-white/20 backdrop-blur-md border border-white/10 text-[11px] font-semibold tracking-wider text-amber-300 uppercase">
              {delivery.video.topic.category}
            </div>
          )}
          <h2 className="text-white text-base font-bold leading-snug drop-shadow-md line-clamp-2">
            {delivery.video.title}
          </h2>
          <p className="text-neutral-300 text-xs line-clamp-2 leading-relaxed opacity-90 drop-shadow">
            {delivery.video.script}
          </p>
        </div>

        {/* 60-Second Custom Micro-Progress Scrub Bar */}
        <div className="w-full h-1 bg-white/20 rounded-full mt-3 overflow-hidden backdrop-blur-sm">
          <div
            className="h-full bg-gradient-to-r from-amber-400 to-emerald-400 transition-all duration-150 ease-linear rounded-full"
            style={{ width: `${Math.min((currentTime / duration) * 100, 100)}%` }}
          />
        </div>
      </footer>

      {/* Completion Modal Trigger */}
      {showCelebration && (
        <HabitCelebrationModal
          onClose={() => setShowCelebration(false)}
          videoTitle={delivery.video.title}
        />
      )}
    </div>
  );
}
