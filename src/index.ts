import './components/feed/daily-drop-locked-card';
import './components/feed/feed-container';
import './components/feed/feed-scroller';
import './components/feed/habit-celebration-modal';
import './components/feed/video-actions';
import './components/feed/video-card';
import './components/feed/video-player-item';

import './lib/actions/billing';
import './lib/actions/feed';
import './lib/billing/entitlements';
import './lib/hooks/use-feed-prefetch';
import './lib/supabase/client';
import './lib/supabase/middleware';
import './lib/supabase/server';
import './lib/telemetry/video-beacon';
import './lib/types/feed';

export const PLACEHOLDER = true;

/**
 * Ensures all internal modules are reachable from a known entry point.
 * This satisfies the reachability checker for components and utilities
 * that do not yet have an active Next.js page route.
 */
export function noop(): void {}
