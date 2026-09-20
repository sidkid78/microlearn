export interface WatchHeartbeatPayload {
  delivery_id: string;
  user_id: string;
  watched_seconds: number;
  session_duration_ms: number;
  completed: boolean;
  timestamp: string;
}

export class VideoTelemetryDispatcher {
  private deliveryId: string;
  private userId: string;
  private startTime: number;
  private lastReportedSeconds: number = 0;
  private endpoint = '/api/telemetry/watch-progress';

  constructor(deliveryId: string, userId: string) {
    this.deliveryId = deliveryId;
    this.userId = userId;
    this.startTime = Date.now();
  }

  public trackProgress(currentVideoSeconds: number, isCompleted: boolean) {
    // Only emit when delta exceeds 3 seconds to avoid network contention
    if (Math.abs(currentVideoSeconds - this.lastReportedSeconds) >= 3.0 || isCompleted) {
      this.lastReportedSeconds = currentVideoSeconds;
      this.sendPayload(currentVideoSeconds, isCompleted, false);
    }
  }

  public flushOnExit(finalVideoSeconds: number, isCompleted: boolean) {
    this.sendPayload(finalVideoSeconds, isCompleted, true);
  }

  private sendPayload(watchedSeconds: number, completed: boolean, useBeacon: boolean) {
    const payload: WatchHeartbeatPayload = {
      delivery_id: this.deliveryId,
      user_id: this.userId,
      watched_seconds: Number(watchedSeconds.toFixed(2)),
      session_duration_ms: Date.now() - this.startTime,
      completed,
      timestamp: new Date().toISOString(),
    };

    const data = JSON.stringify(payload);

    if (useBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([data], { type: 'application/json' });
      navigator.sendBeacon(this.endpoint, blob);
    } else if (typeof fetch === 'function') {
      fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: data,
        keepalive: true,
      }).catch((err) => console.error('Telemetry reporting error:', err));
    }
  }
}
