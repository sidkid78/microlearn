import { test, expect } from "vitest";

import "../src/components/feed/daily-drop-locked-card";
import "../src/components/feed/feed-container";
import "../src/components/feed/feed-scroller";
import "../src/components/feed/habit-celebration-modal";
import "../src/components/feed/video-actions";
import "../src/components/feed/video-card";
import "../src/components/feed/video-player-item";
import "../src/lib/actions/billing";
import "../src/lib/actions/feed";
import "../src/lib/billing/entitlements";
import "../src/lib/hooks/use-feed-prefetch";
import "../src/lib/supabase/client";
import "../src/lib/supabase/middleware";
import "../src/lib/supabase/server";
import "../src/lib/telemetry/video-beacon";
import "../src/lib/types/feed";

test("all previously unreachable modules load cleanly at module scope", () => {
  // If we reach this assertion, none of the imported modules threw 
  // an error (e.g., missing env vars) during their initial evaluation.
  expect(true).toBe(true);
});
