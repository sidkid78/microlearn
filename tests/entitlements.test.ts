import { describe, it, expect } from 'vitest';
import { calculateEntitlements, type EntitlementInput } from '../src/lib/billing/entitlements';

describe('Entitlement Logic', () => {
  it('allows access for active pro subscribers', () => {
    const input: EntitlementInput = {
      subscriptionStatus: 'active',
      tierSlug: 'pro',
      maxProfessions: 3,
      longestStreak: 5,
    };
    const result = calculateEntitlements(input);
    expect(result.canAccessDailyFeed).toBe(true);
    expect(result.isPro).toBe(true);
    expect(result.reason).toBe('ACTIVE');
  });

  it('allows access for trialing users within streak limit (3 days)', () => {
    const input: EntitlementInput = {
      subscriptionStatus: 'trialing',
      tierSlug: 'free',
      maxProfessions: 1,
      longestStreak: 2,
    };
    const result = calculateEntitlements(input);
    expect(result.canAccessDailyFeed).toBe(true);
    expect(result.isTrialExpired).toBe(false);
  });

  it('gates access for trialing users who exceed streak limit', () => {
    const input: EntitlementInput = {
      subscriptionStatus: 'trialing',
      tierSlug: 'free',
      maxProfessions: 1,
      longestStreak: 3,
    };
    const result = calculateEntitlements(input);
    expect(result.canAccessDailyFeed).toBe(false);
    expect(result.isTrialExpired).toBe(true);
    expect(result.reason).toBe('TRIAL_EXPIRED');
  });

  it('gates access for canceled or unpaid status', () => {
    const input: EntitlementInput = {
      subscriptionStatus: 'canceled',
      tierSlug: 'pro',
      maxProfessions: 3,
      longestStreak: 10,
    };
    const result = calculateEntitlements(input);
    expect(result.canAccessDailyFeed).toBe(false);
    expect(result.reason).toBe('CANCELED');
  });

  it('gates access for past_due status', () => {
    const input: EntitlementInput = {
      subscriptionStatus: 'past_due',
      tierSlug: 'pro',
      maxProfessions: 3,
      longestStreak: 10,
    };
    const result = calculateEntitlements(input);
    expect(result.canAccessDailyFeed).toBe(false);
    expect(result.reason).toBe('PAST_DUE');
  });
});
