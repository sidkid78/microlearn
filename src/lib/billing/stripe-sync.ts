import { supabaseAdmin } from '../supabase/admin';
import type Stripe from 'stripe';

/**
 * Upserts user profile tier and billing status from a Stripe Subscription object.
 */
export async function syncStripeSubscriptionToProfile(
  subscription: Stripe.Subscription
): Promise<void> {
  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id;

  if (!customerId) {
    throw new Error('Subscription does not have an associated customer ID.');
  }

  // Retrieve user matching this customer
  const { data: profile, error: fetchError } = await supabaseAdmin
    .from('profiles')
    .select('id, tier_id, subscription_status')
    .eq('stripe_customer_id', customerId)
    .single();

  if (fetchError || !profile) {
    throw new Error(
      `No profile found matching stripe_customer_id: ${customerId}. Error: ${fetchError?.message}`
    );
  }

  // Identify the corresponding subscription_tier from price id
  const priceId = subscription.items.data[0]?.price?.id;

  let targetTierId: string | null = null;
  if (priceId) {
    const { data: tier } = await supabaseAdmin
      .from('subscription_tiers')
      .select('id')
      .eq('stripe_price_id', priceId)
      .maybeSingle();

    if (tier) {
      targetTierId = tier.id;
    }
  }

  // Fallback to Pro tier if matching price not found directly
  if (!targetTierId) {
    const { data: proTier } = await supabaseAdmin
      .from('subscription_tiers')
      .select('id')
      .eq('slug', 'pro')
      .maybeSingle();
    targetTierId = proTier?.id || profile.tier_id;
  }

  // Map Stripe Subscription Status to DB Subscription Status Enum
  let mappedStatus: 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid';

  switch (subscription.status) {
    case 'active':
      mappedStatus = 'active';
      break;
    case 'trialing':
      mappedStatus = 'trialing';
      break;
    case 'past_due':
      mappedStatus = 'past_due';
      break;
    case 'canceled':
    case 'incomplete_expired':
      mappedStatus = 'canceled';
      break;
    case 'unpaid':
    case 'incomplete':
      mappedStatus = 'unpaid';
      break;
    default:
      mappedStatus = 'canceled';
  }

  const { error: updateError } = await supabaseAdmin
    .from('profiles')
    .update({
      tier_id: targetTierId,
      subscription_status: mappedStatus,
      updated_at: new Date().toISOString(),
    })
    .eq('id', profile.id);

  if (updateError) {
    throw new Error(`Failed to sync profile ${profile.id}: ${updateError.message}`);
  }
}

/**
 * Handles initial checkout completion by linking the customer ID to profile.
 */
export async function linkCustomerToProfile(
  session: Stripe.Checkout.Session
): Promise<void> {
  const userId = session.client_reference_id;
  const customerId =
    typeof session.customer === 'string'
      ? session.customer
      : session.customer?.id;

  if (!userId || !customerId) {
    throw new Error('Checkout session missing client_reference_id or customer ID.');
  }

  const { error } = await supabaseAdmin
    .from('profiles')
    .update({
      stripe_customer_id: customerId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId);

  if (error) {
    throw new Error(`Failed to assign stripe_customer_id to user ${userId}: ${error.message}`);
  }
}
