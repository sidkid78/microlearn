import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { stripe } from '../../../../lib/stripe/client';
import {
  syncStripeSubscriptionToProfile,
  linkCustomerToProfile,
} from '../../../../lib/billing/stripe-sync';
import { supabaseAdmin } from '../../../../lib/supabase/admin';
import type Stripe from 'stripe';

const relevantEvents = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
]);

export async function POST(req: Request) {
  const body = await req.text();
  const headerList = await headers();
  const signature = headerList.get('stripe-signature');
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    return NextResponse.json(
      { error: 'Webhook secret or signature missing' },
      { status: 400 }
    );
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`⚠️ Webhook signature verification failed: ${message}`);
    return NextResponse.json({ error: `Webhook Error: ${message}` }, { status: 400 });
  }

  if (relevantEvents.has(event.type)) {
    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const checkoutSession = event.data.object as Stripe.Checkout.Session;
          await linkCustomerToProfile(checkoutSession);

          if (checkoutSession.subscription) {
            const subId =
              typeof checkoutSession.subscription === 'string'
                ? checkoutSession.subscription
                : checkoutSession.subscription.id;
            const subscription = await stripe.subscriptions.retrieve(subId);
            await syncStripeSubscriptionToProfile(subscription);
          }
          break;
        }

        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const subscription = event.data.object as Stripe.Subscription;
          await syncStripeSubscriptionToProfile(subscription);
          break;
        }

        case 'invoice.payment_succeeded': {
          const invoice = event.data.object as Stripe.Invoice;
          const invoiceSub = (invoice as { subscription?: string | { id: string } | null }).subscription;
          if (invoiceSub) {
            const subId = typeof invoiceSub === 'string' ? invoiceSub : invoiceSub.id;
            const subscription = await stripe.subscriptions.retrieve(subId);
            await syncStripeSubscriptionToProfile(subscription);
          }
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object as Stripe.Invoice;
          const customerId =
            typeof invoice.customer === 'string'
              ? invoice.customer
              : invoice.customer?.id;

          if (customerId) {
            // Immediately mark status past_due in profile
            await supabaseAdmin
              .from('profiles')
              .update({
                subscription_status: 'past_due',
                updated_at: new Date().toISOString(),
              })
              .eq('stripe_customer_id', customerId);
          }
          break;
        }

        default:
          throw new Error(`Unhandled relevant event: ${event.type}`);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Webhook handler error';
      console.error(`Error processing webhook event ${event.id}:`, msg);
      return NextResponse.json(
        { error: 'Webhook handler failed. Will retry.' },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
