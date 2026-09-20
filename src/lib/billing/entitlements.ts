import { createClient } from '../supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

export interface UserEntitlements {
  canAccessDailyFeed: boolean;
  canChangeProfession: boolean;
  isPro: boolean;
  isTrialing: boolean;
  isTrialExpired: boolean;
  streakDaysCompleted: number;
  reason?: 'TRIAL_EXPIRED' | 'PAST_DUE' | 'CANCELED' | 'ACTIVE';
}

export interface EntitlementInput {
  subscriptionStatus: Database['public']['Enums']['subscription_status'] | string;
  tierSlug?: string | null;
  maxProfessions?: number | null;
  longestStreak?: number | null;
}

/**
 * Pure entitlement calculation based on subscription tier and streak rules.
 */
export function calculateEntitlements(input: EntitlementInput): UserEntitlements {
  const { subscriptionStatus, tierSlug, maxProfessions = 1, longestStreak = 0 } = input;
  const totalCompletedDays = longestStreak ?? 0;
  const isPro = tierSlug === 'pro' && subscriptionStatus === 'active';
  const isTrialing = subscriptionStatus === 'trialing';

  // Free Tier Rule: 3 completed days trial
  if (isTrialing) {
    if (totalCompletedDays >= 3) {
      return {
        canAccessDailyFeed: false,
        canChangeProfession: false,
        isPro: false,
        isTrialing: true,
        isTrialExpired: true,
        streakDaysCompleted: totalCompletedDays,
        reason: 'TRIAL_EXPIRED',
      };
    }

    return {
      canAccessDailyFeed: true,
      canChangeProfession: false,
      isPro: false,
      isTrialing: true,
      isTrialExpired: false,
      streakDaysCompleted: totalCompletedDays,
      reason: 'ACTIVE',
    };
  }

  if (subscriptionStatus === 'active') {
    return {
      canAccessDailyFeed: true,
      canChangeProfession: (maxProfessions ?? 1) > 1,
      isPro,
      isTrialing: false,
      isTrialExpired: false,
      streakDaysCompleted: totalCompletedDays,
      reason: 'ACTIVE',
    };
  }

  return {
    canAccessDailyFeed: false,
    canChangeProfession: false,
    isPro: false,
    isTrialing: false,
    isTrialExpired: false,
    streakDaysCompleted: totalCompletedDays,
    reason: subscriptionStatus === 'past_due' ? 'PAST_DUE' : 'CANCELED',
  };
}

/**
 * Checks user entitlements against database profiles, subscription tiers, and streaks.
 */
export async function checkUserEntitlements(
  userId: string,
  client?: SupabaseClient<Database>
): Promise<UserEntitlements> {
  const supabase = client ?? (await createClient());

  const { data: profile } = await supabase
    .from('profiles')
    .select(`
      subscription_status,
      tier:subscription_tiers (
        slug,
        daily_video_limit,
        max_professions
      ),
      streaks:user_streaks (
        current_streak,
        longest_streak
      )
    `)
    .eq('id', userId)
    .maybeSingle();

  if (!profile) {
    return {
      canAccessDailyFeed: false,
      canChangeProfession: false,
      isPro: false,
      isTrialing: false,
      isTrialExpired: true,
      streakDaysCompleted: 0,
      reason: 'CANCELED',
    };
  }

  type TierRecord = { slug: string; daily_video_limit: number; max_professions: number };
  type StreakRecord = { current_streak: number; longest_streak: number };

  const tier = (Array.isArray(profile.tier) ? profile.tier[0] : profile.tier) as TierRecord | null;
  const streaks = (Array.isArray(profile.streaks) ? profile.streaks[0] : profile.streaks) as StreakRecord | null;

  return calculateEntitlements({
    subscriptionStatus: profile.subscription_status,
    tierSlug: tier?.slug,
    maxProfessions: tier?.max_professions,
    longestStreak: streaks?.longest_streak,
  });
}
