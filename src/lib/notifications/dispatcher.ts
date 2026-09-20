import { createRequire } from 'node:module';
import { supabaseAdmin } from '../supabase/admin';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

export interface WebPushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export namespace webpush {
  export type PushSubscription = WebPushSubscription;
}

export interface WebPushSendResult {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
}

interface WebPushClient {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    subscription: webpush.PushSubscription,
    payload?: string | Uint8Array,
    options?: Record<string, unknown>
  ): Promise<WebPushSendResult>;
}

let webPushClientInstance: WebPushClient | null = null;

function getWebPushClient(): WebPushClient {
  if (!webPushClientInstance) {
    const require = createRequire(import.meta.url);
    webPushClientInstance = require('web-push') as WebPushClient;
  }
  return webPushClientInstance;
}

export const webpush = {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void {
    getWebPushClient().setVapidDetails(subject, publicKey, privateKey);
  },
  sendNotification(
    subscription: webpush.PushSubscription,
    payload?: string | Uint8Array,
    options?: Record<string, unknown>
  ): Promise<WebPushSendResult> {
    return getWebPushClient().sendNotification(subscription, payload, options);
  },
};

let vapidConfigured = false;

function ensureVapidDetails(): boolean {
  if (vapidConfigured) return true;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;

  if (publicKey && privateKey) {
    webpush.setVapidDetails('mailto:support@microlearn.pro', publicKey, privateKey);
    vapidConfigured = true;
    return true;
  }
  return false;
}

export interface DispatchPayload {
  userId: string;
  email: string;
  userName: string;
  professionTitle: string;
  lessonTitle: string;
  deliveryId: string;
  streakCount: number;
}

/**
 * Creates a zero-friction Supabase Magic Link direct to the video feed.
 */
export async function generateLessonMagicLink(
  email: string,
  deliveryId: string,
  adminClient: SupabaseClient<Database> = supabaseAdmin
): Promise<string> {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://microlearn.pro';

  const { data, error } = await adminClient.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: {
      redirectTo: `${siteUrl}/feed?deliveryId=${deliveryId}`,
    },
  });

  if (error || !data.properties?.action_link) {
    return `${siteUrl}/feed?deliveryId=${deliveryId}`;
  }

  return data.properties.action_link;
}

/**
 * Builds HTML template for daily micro-lesson email.
 */
export function buildDailyLessonEmailHtml(payload: DispatchPayload, magicLink: string): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0c0a09; color: #f5f5f4; margin: 0; padding: 24px; }
      .card { max-width: 460px; margin: 0 auto; background-color: #1c1917; border: 1px solid #292524; border-radius: 16px; padding: 24px; }
      .pill { display: inline-block; background-color: #f97316; color: #ffffff; padding: 4px 12px; border-radius: 9999px; font-weight: 700; font-size: 12px; margin-bottom: 12px; }
      h1 { font-size: 20px; font-weight: 700; margin: 0 0 8px 0; color: #fafaf9; }
      p { font-size: 14px; line-height: 1.5; color: #a8a29e; margin: 0 0 20px 0; }
      .cta { display: block; text-align: center; background-color: #ffffff; color: #0c0a09; text-decoration: none; padding: 14px 20px; border-radius: 12px; font-weight: 600; font-size: 15px; }
      .footer { text-align: center; margin-top: 20px; font-size: 11px; color: #78716c; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="pill">🔥 ${payload.streakCount} DAY STREAK</div>
      <h1>${payload.lessonTitle}</h1>
      <p>Hey ${payload.userName || 'Solopreneur'}, your daily 60-second micro-lesson for <strong>${payload.professionTitle}</strong> is ready to watch.</p>
      <a href="${magicLink}" class="cta">Skill Up in 60 Seconds →</a>
      <div class="footer">
        No password required. Clicking logs you in instantly.<br/>
        MicroLearn Pro • 60-Second Daily Professional Mastery
      </div>
    </div>
  </body>
</html>`;
}

/**
 * Dispatches an email via Resend API.
 */
export async function sendDailyLessonEmail(
  payload: DispatchPayload,
  magicLink: string,
  fetchFn: typeof fetch = fetch
): Promise<{ success: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { success: false, error: 'RESEND_API_KEY missing.' };

  const subject = `🔥 ${payload.streakCount} Day Streak: Your 60s ${payload.professionTitle} Lesson is Ready`;
  const html = buildDailyLessonEmailHtml(payload, magicLink);

  try {
    const response = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'MicroLearn Pro <daily@microlearn.pro>',
        to: [payload.email],
        subject,
        html,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return { success: false, error: err };
    }

    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Dispatches a native Web Push Notification if a subscription exists in delivery_metadata.
 */
export async function sendWebPushNotification(
  pushSubscription: webpush.PushSubscription,
  payload: { title: string; body: string; url: string }
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!ensureVapidDetails()) {
      return { success: false, error: 'VAPID credentials missing from environment.' };
    }

    await webpush.sendNotification(
      pushSubscription,
      JSON.stringify({
        title: payload.title,
        body: payload.body,
        icon: '/icons/icon-192x192.png',
        badge: '/icons/badge-72x72.png',
        data: { url: payload.url },
      })
    );
    return { success: true };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : 'Push failed' };
  }
}
