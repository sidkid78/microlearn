export interface Topic {
  title: string;
  category: string;
  difficulty_level: number;
}

export interface GeneratedVideo {
  id: string;
  title: string;
  script: string;
  captions: Record<string, unknown> | null;
  video_storage_path: string;
  thumbnail_storage_path: string;
  duration_seconds: number;
  streamUrl: string;
  thumbnailUrl: string;
  /**
   * Slides shown over the narration, with their cue points.
   *
   * A lesson is an audio track plus a handful of images rather than a
   * rendered MP4, so the timing that used to be baked into video frames
   * travels here and the client does the switching.
   */
  slides: SlideCue[];
  topic: Topic | null;
}

export interface SlideCue {
  sequence: number;
  startSecond: number;
  endSecond: number;
  url: string;
  onScreenHook: string;
}

export interface DeliveryWithVideo {
  id: string;
  scheduled_for: string;
  status: 'queued' | 'delivered' | 'watched' | 'skipped';
  watched_at: string | null;
  watch_duration_seconds: number | null;
  is_completed: boolean;
  video: GeneratedVideo;
}
