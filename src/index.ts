export const PLACEHOLDER = true;

// Components
export * from './components/feed/daily-drop-locked-card';
export * from './components/feed/feed-container';
export * from './components/feed/feed-scroller';
export * from './components/feed/habit-celebration-modal';
export * from './components/feed/video-actions';
export * from './components/feed/video-card';
export * from './components/feed/video-player-item';

// Actions
export * from './lib/actions/billing';
export * from './lib/actions/feed';

// Billing & Entitlements
export * from './lib/billing/entitlements';
export * from './lib/billing/stripe-sync';

// Hooks
export * from './lib/hooks/use-feed-prefetch';

// Notifications
export * from './lib/notifications/dispatcher';

// Stripe
export * from './lib/stripe/client';

// Supabase
export * from './lib/supabase/admin';
import * as supabaseClient from './lib/supabase/client';
import * as supabaseMiddleware from './lib/supabase/middleware';
import * as supabaseServer from './lib/supabase/server';
export { supabaseClient, supabaseMiddleware, supabaseServer };

// Telemetry
export * from './lib/telemetry/video-beacon';

// Types
export * from './lib/types/feed';
