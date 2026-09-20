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
  topic: Topic | null;
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
