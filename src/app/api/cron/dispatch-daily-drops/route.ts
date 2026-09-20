import { NextResponse } from 'next/server';
import { supabaseAdmin } from '../../../../lib/supabase/admin';
import {
  generateLessonMagicLink,
  sendDailyLessonEmail,
} from '../../../../lib/notifications/dispatcher';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export function isUserEligibleForDailyDrop(user: {
  subscriptionStatus: string;
  selectedProfessionId: string | null;
  longestStreak?: number | null;
}): boolean {
  if (!user.selectedProfessionId) {
    return false;
  }
  if (user.subscriptionStatus === 'trialing' && (user.longestStreak ?? 0) >= 3) {
    return false;
  }
  return user.subscriptionStatus === 'active' || user.subscriptionStatus === 'trialing';
}

export async function GET(req: Request) {
  // 1. Authorize Cron Runner
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized invocation' }, { status: 401 });
  }

  const currentUtcHour = new Date().getUTCHours();
  const todayDateString = new Date().toISOString().split('T')[0];

  try {
    // 2. Fetch all profiles configured for the current UTC hour
    const { data: eligibleUsers, error: usersError } = await supabaseAdmin
      .from('profiles')
      .select(`
        id,
        email,
        full_name,
        subscription_status,
        selected_profession_id,
        tier:subscription_tiers (
          slug,
          daily_video_limit
        ),
        profession:niche_professions (
          id,
          title
        ),
        streak:user_streaks (
          current_streak,
          longest_streak
        )
      `)
      .eq('delivery_hour_utc', currentUtcHour)
      .in('subscription_status', ['active', 'trialing']);

    if (usersError) {
      throw new Error(`Profile query error: ${usersError.message}`);
    }

    if (!eligibleUsers || eligibleUsers.length === 0) {
      return NextResponse.json({
        message: `No active deliveries scheduled for hour UTC ${currentUtcHour}.`,
        dispatched: 0,
      });
    }

    let dispatchedCount = 0;
    const errors: Array<{ userId: string; error: string }> = [];

    // 3. Process Users Concurrently in Batches of 10
    const BATCH_SIZE = 10;
    for (let i = 0; i < eligibleUsers.length; i += BATCH_SIZE) {
      const batch = eligibleUsers.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (user) => {
          try {
            type StreakShape = { current_streak: number; longest_streak: number };
            type ProfessionShape = { id: string; title: string };

            const streakData = (
              Array.isArray(user.streak) ? user.streak[0] : user.streak
            ) as StreakShape | null;

            const professionData = (
              Array.isArray(user.profession) ? user.profession[0] : user.profession
            ) as ProfessionShape | null;

            // Enforce eligibility and trial limit
            if (
              !isUserEligibleForDailyDrop({
                subscriptionStatus: user.subscription_status,
                selectedProfessionId: user.selected_profession_id,
                longestStreak: streakData?.longest_streak,
              })
            ) {
              return;
            }

            // Check if user already received a delivery today
            const { data: existingDelivery } = await supabaseAdmin
              .from('user_feed_deliveries')
              .select('id')
              .eq('user_id', user.id)
              .eq('scheduled_for', todayDateString)
              .maybeSingle();

            if (existingDelivery) {
              return;
            }

            // Fetch previously watched/delivered video IDs for exclusion
            const { data: pastDeliveries } = await supabaseAdmin
              .from('user_feed_deliveries')
              .select('video_id')
              .eq('user_id', user.id);

            const excludedVideoIds = pastDeliveries?.map((d) => d.video_id) || [];

            // Select next unviewed video matching the user's selected profession
            let videoQuery = supabaseAdmin
              .from('generated_videos')
              .select(`
                id,
                title,
                topic:topics!inner (
                  profession_id
                )
              `)
              .eq('generation_status', 'ready')
              .eq('topic.profession_id', user.selected_profession_id!);

            if (excludedVideoIds.length > 0) {
              videoQuery = videoQuery.not('id', 'in', `(${excludedVideoIds.join(',')})`);
            }

            const { data: candidateVideos } = await videoQuery.limit(1);

            let selectedVideoId: string;
            let selectedLessonTitle: string;

            if (candidateVideos && candidateVideos.length > 0) {
              selectedVideoId = candidateVideos[0].id;
              selectedLessonTitle = candidateVideos[0].title;
            } else {
              // Graceful fallback: If curriculum exhausted, select the top-performing past video
              const { data: fallbackVideo } = await supabaseAdmin
                .from('generated_videos')
                .select('id, title')
                .eq('generation_status', 'ready')
                .limit(1)
                .single();

              if (!fallbackVideo) {
                throw new Error('No ready videos found in system catalogue.');
              }
              selectedVideoId = fallbackVideo.id;
              selectedLessonTitle = fallbackVideo.title;
            }

            // Insert feed delivery record
            const { data: insertedDelivery, error: insertError } = await supabaseAdmin
              .from('user_feed_deliveries')
              .insert({
                user_id: user.id,
                video_id: selectedVideoId,
                scheduled_for: todayDateString,
                status: 'delivered',
                delivery_metadata: {
                  channel: 'email',
                  dispatched_at: new Date().toISOString(),
                },
              })
              .select('id')
              .single();

            if (insertError || !insertedDelivery) {
              throw new Error(`Delivery record insertion failed: ${insertError?.message}`);
            }

            // Generate authenticated Magic Link
            const magicLink = await generateLessonMagicLink(user.email, insertedDelivery.id);

            // Dispatch notification
            const emailResult = await sendDailyLessonEmail(
              {
                userId: user.id,
                email: user.email,
                userName: user.full_name || 'Solopreneur',
                professionTitle: professionData?.title || 'Professional Mastery',
                lessonTitle: selectedLessonTitle || 'Daily Micro-Skill',
                deliveryId: insertedDelivery.id,
                streakCount: (streakData?.current_streak ?? 0) + 1,
              },
              magicLink
            );

            if (!emailResult.success) {
              console.error(`Email delivery failed for ${user.email}:`, emailResult.error);
            }

            dispatchedCount++;
          } catch (itemError: unknown) {
            const errString = itemError instanceof Error ? itemError.message : 'Unknown item error';
            errors.push({ userId: user.id, error: errString });
          }
        })
      );
    }

    return NextResponse.json({
      status: 'complete',
      hourUtc: currentUtcHour,
      dispatched: dispatchedCount,
      errorsCount: errors.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (cronError: unknown) {
    const errorMsg = cronError instanceof Error ? cronError.message : 'Fatal cron failure';
    console.error('Cron dispatch execution failed:', errorMsg);
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
