import { createClient } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { FeedContainer } from '@/components/feed/feed-container';
import { DailyDropLockedCard } from '@/components/feed/daily-drop-locked-card';
import { checkUserEntitlements } from '@/lib/billing/entitlements';
import { DELIVERY_SELECT, signDeliveries } from '@/lib/feed/deliveries';

export default async function Home() {
  const sessionClient = await createClient();

  const {
    data: { user },
  } = await sessionClient.auth.getUser();

  // Local development only: adopt a seeded user instead of signing in.
  //
  // There is no auth UI in this project yet, so the home page can only
  // ever render its locked state — which makes the feed impossible to
  // look at while building it. `npm run seed:dev` creates a real user
  // with a real profile, entitlement and deliveries, and this adopts
  // that id.
  //
  // It is NOT a way around the entitlement check: everything below still
  // runs, so a seeded user on a tier without access still sees the
  // locked card. The only thing skipped is proving who you are.
  //
  // Two conditions, both required, so this cannot reach production:
  // NODE_ENV is `production` in any real deployment, and the variable
  // lives in .env.local, which is gitignored.
  const devUserId =
    process.env.NODE_ENV !== 'production' ? process.env.DEV_BYPASS_USER_ID : undefined;

  if (!user && !devUserId) {
    return <DailyDropLockedCard deliveryHourUtc={12} />;
  }

  const userId = user?.id ?? (devUserId as string);

  // Skipping auth is not enough on its own: every query below runs
  // through RLS, which correctly denies an unauthenticated request. So
  // the bypass path reads with the service-role client — the same one
  // the webhooks and the pipeline already use — while a real session
  // keeps using the session client and stays subject to RLS.
  const supabase = user ? sessionClient : getSupabaseAdmin();

  // Check user entitlements before proceeding with expensive feed data fetching
  const entitlements = await checkUserEntitlements(userId, supabase);

  // Fetch profile to get deliveryHourUtc for fallback or gating UI
  const { data: profile } = await supabase
    .from('profiles')
    .select('delivery_hour_utc')
    .eq('id', userId)
    .single();

  const deliveryHourUtc = profile?.delivery_hour_utc ?? 12;

  // Gate content if entitlement check fails
  if (!entitlements.canAccessDailyFeed) {
    return <DailyDropLockedCard deliveryHourUtc={deliveryHourUtc} />;
  }

  // Fetch streak
  const { data: streak } = await supabase
    .from('user_streaks')
    .select('current_streak, longest_streak')
    .eq('user_id', userId)
    .single();

  // Fetch deliveries with videos and topics
  const { data: deliveriesData } = await supabase
    .from('user_feed_deliveries')
    .select(DELIVERY_SELECT)
    .eq('user_id', userId)
    .order('scheduled_for', { ascending: false });

  if (!deliveriesData || deliveriesData.length === 0) {
    return <DailyDropLockedCard deliveryHourUtc={deliveryHourUtc} />;
  }

  const initialDeliveries = await signDeliveries(supabase, deliveriesData);

  return (
    <main className="h-screen w-full bg-black overflow-hidden">
      <FeedContainer
        initialDeliveries={initialDeliveries}
        streak={streak}
        userId={userId}
      />
    </main>
  );
}
