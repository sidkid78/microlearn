'use server';

import { createClient } from '../supabase/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

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
