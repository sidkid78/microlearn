'use server';

import { createClient } from '../supabase/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseAdmin } from '../supabase/admin';
import { DELIVERY_SELECT, signDeliveries } from '../feed/deliveries';
import type { DeliveryWithVideo } from '../types/feed';

const ProgressSchema = z.object({
  deliveryId: z.string().uuid(),
  watchedSeconds: z.number().min(0).max(120),
  completed: z.boolean(),
});

export type ActionResponse<T = null> = {
  success: boolean;
  data?: T;
  error?: string;
};

export async function recordWatchProgress(
  input: z.infer<typeof ProgressSchema>
): Promise<ActionResponse> {
  const parseResult = ProgressSchema.safeParse(input);
  if (!parseResult.success) {
    return { success: false, error: 'Invalid progress parameters.' };
  }

  const { deliveryId, watchedSeconds } = parseResult.data;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, error: 'Unauthorized.' };
  }

  const { error } = await supabase
    .from('user_feed_deliveries')
    .update({
      watch_duration_seconds: watchedSeconds,
      watched_at: new Date().toISOString(),
    })
    .eq('id', deliveryId)
    .eq('user_id', user.id);

  if (error) {
    console.error('Failed to update watch progress:', error.message);
    return { success: false, error: 'Database synchronization failed.' };
  }

  revalidatePath('/dashboard', 'page');
  
  return { success: true };
}

const InteractionSchema = z.object({
  deliveryId: z.string().uuid(),
  bookmarked: z.boolean(),
});

export async function toggleBookmarkAction(
  input: z.infer<typeof InteractionSchema>
): Promise<ActionResponse<{ bookmarked: boolean }>> {
  const parseResult = InteractionSchema.safeParse(input);
  if (!parseResult.success) {
    return { success: false, error: 'Invalid parameters.' };
  }
  
  const { deliveryId, bookmarked } = parseResult.data;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, error: 'Unauthorized' };
  }

  const { error } = await supabase
    .from('user_feed_deliveries')
    .update({
      delivery_metadata: { bookmarked },
    })
    .eq('id', deliveryId)
    .eq('user_id', user.id);

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath('/archive', 'page');
  return { success: true, data: { bookmarked } };
}

/**
 * The next page of the feed, with every storage path already signed.
 *
 * Pagination used to run in the browser: `feed-scroller.tsx` queried
 * Supabase with the anon client and built its own asset URLs. That was
 * broken in three ways at once (see `src/lib/feed/deliveries.ts`), and
 * it could not be fixed in place, because signing needs a server. Under
 * the dev bypass the browser has no session at all, so storage RLS
 * denies it and the feed just stops scrolling.
 *
 * So the client asks for a page and gets back render-ready deliveries.
 * It no longer knows which bucket anything is in.
 */
const PageSchema = z.object({
  before: z.string().min(1),
  limit: z.number().int().min(1).max(20).default(5),
});

export async function loadMoreDeliveries(
  input: z.infer<typeof PageSchema>
): Promise<ActionResponse<DeliveryWithVideo[]>> {
  const parsed = PageSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid pagination parameters.' };
  }

  const sessionClient = await createClient();
  const {
    data: { user },
  } = await sessionClient.auth.getUser();

  // Mirrors the home page: a real session reads under RLS, the seeded
  // dev user reads with the service role. Neither path lets the caller
  // name a user — the id comes from the session or the environment, so
  // this cannot be used to page through somebody else's feed.
  const devUserId =
    process.env.NODE_ENV !== 'production' ? process.env.DEV_BYPASS_USER_ID : undefined;
  if (!user && !devUserId) {
    return { success: false, error: 'Unauthorized' };
  }

  const userId = user?.id ?? (devUserId as string);
  const supabase = user ? sessionClient : getSupabaseAdmin();

  const { data, error } = await supabase
    .from('user_feed_deliveries')
    .select(DELIVERY_SELECT)
    .eq('user_id', userId)
    .lt('scheduled_for', parsed.data.before)
    .order('scheduled_for', { ascending: false })
    .limit(parsed.data.limit);

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, data: await signDeliveries(supabase, data ?? []) };
}
