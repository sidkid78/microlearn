-- 1. Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Custom Enum Types
CREATE TYPE user_role AS ENUM ('member', 'admin', 'service_role');
CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'past_due', 'canceled', 'unpaid');
CREATE TYPE video_generation_status AS ENUM ('pending', 'scripting', 'rendering', 'ready', 'failed');
CREATE TYPE delivery_status AS ENUM ('queued', 'delivered', 'watched', 'skipped');

-- 3. Tables & Constraints

-- 3.1 subscription_tiers
CREATE TABLE public.subscription_tiers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) NOT NULL UNIQUE,
    slug VARCHAR(50) NOT NULL UNIQUE,
    stripe_price_id VARCHAR(100) UNIQUE,
    daily_video_limit INT NOT NULL DEFAULT 1,
    max_professions INT NOT NULL DEFAULT 1,
    features JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 3.2 niche_professions
CREATE TABLE public.niche_professions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(60) NOT NULL UNIQUE,
    title VARCHAR(100) NOT NULL,
    description TEXT,
    icon_url TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 3.3 profiles
CREATE TABLE public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    full_name VARCHAR(100),
    avatar_url TEXT,
    role user_role NOT NULL DEFAULT 'member',
    tier_id UUID NOT NULL REFERENCES public.subscription_tiers(id),
    subscription_status subscription_status NOT NULL DEFAULT 'trialing',
    stripe_customer_id VARCHAR(100) UNIQUE,
    selected_profession_id UUID REFERENCES public.niche_professions(id) ON DELETE SET NULL,
    timezone VARCHAR(50) NOT NULL DEFAULT 'UTC',
    delivery_hour_utc SMALLINT NOT NULL DEFAULT 6 CHECK (delivery_hour_utc BETWEEN 0 AND 23),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX idx_profiles_delivery_time ON public.profiles(delivery_hour_utc, timezone);
CREATE INDEX idx_profiles_profession ON public.profiles(selected_profession_id);

-- 3.4 topics
CREATE TABLE public.topics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profession_id UUID NOT NULL REFERENCES public.niche_professions(id) ON DELETE CASCADE,
    title VARCHAR(150) NOT NULL,
    category VARCHAR(50) NOT NULL,
    difficulty_level SMALLINT NOT NULL DEFAULT 1 CHECK (difficulty_level BETWEEN 1 AND 5),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX idx_topics_profession ON public.topics(profession_id);

-- 3.5 generated_videos
CREATE TABLE public.generated_videos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    topic_id UUID NOT NULL REFERENCES public.topics(id) ON DELETE RESTRICT,
    title VARCHAR(200) NOT NULL,
    script TEXT NOT NULL,
    captions JSONB,
    video_storage_path TEXT NOT NULL,
    thumbnail_storage_path TEXT NOT NULL,
    duration_seconds NUMERIC(4, 2) NOT NULL DEFAULT 60.00 CHECK (duration_seconds <= 75.00),
    generation_status video_generation_status NOT NULL DEFAULT 'pending',
    ai_metadata JSONB DEFAULT '{}'::jsonb,
    render_errors TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX idx_videos_topic ON public.generated_videos(topic_id);
CREATE INDEX idx_videos_status ON public.generated_videos(generation_status);

-- 3.6 user_feed_deliveries
CREATE TABLE public.user_feed_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    video_id UUID NOT NULL REFERENCES public.generated_videos(id) ON DELETE RESTRICT,
    scheduled_for DATE NOT NULL,
    status delivery_status NOT NULL DEFAULT 'queued',
    delivery_metadata JSONB DEFAULT '{}'::jsonb,
    watched_at TIMESTAMPTZ,
    watch_duration_seconds NUMERIC(5, 2) DEFAULT 0.00,
    is_completed BOOLEAN GENERATED ALWAYS AS (watch_duration_seconds >= 50.00) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT unique_user_video_scheduled UNIQUE(user_id, video_id, scheduled_for)
);

CREATE INDEX idx_deliveries_user_date ON public.user_feed_deliveries(user_id, scheduled_for DESC);
CREATE INDEX idx_deliveries_status ON public.user_feed_deliveries(status);

-- 3.7 user_streaks
CREATE TABLE public.user_streaks (
    user_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    current_streak INT NOT NULL DEFAULT 0,
    longest_streak INT NOT NULL DEFAULT 0,
    last_completed_date DATE,
    freeze_tokens_remaining SMALLINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 4. Trigger Functions & Automation Logic

-- 4.1 Automated Profile & Streak Initialization
CREATE OR REPLACE FUNCTION public.handle_new_user_registration()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_default_tier_id UUID;
    v_default_profession_id UUID;
BEGIN
    -- Resolve default Free/Trial subscription tier
    SELECT id INTO v_default_tier_id 
    FROM public.subscription_tiers 
    WHERE slug = 'free' OR slug = 'starter'
    LIMIT 1;

    -- Pick fallback profession if none selected during signup metadata
    SELECT id INTO v_default_profession_id 
    FROM public.niche_professions 
    ORDER BY id ASC 
    LIMIT 1;

    -- Insert Profile
    INSERT INTO public.profiles (
        id,
        email,
        full_name,
        avatar_url,
        tier_id,
        selected_profession_id,
        subscription_status
    ) VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'full_name', 'Solopreneur'),
        NEW.raw_user_meta_data->>'avatar_url',
        v_default_tier_id,
        COALESCE((NEW.raw_user_meta_data->>'profession_id')::uuid, v_default_profession_id),
        'trialing'
    );

    -- Initialize Streak Ledger
    INSERT INTO public.user_streaks (
        user_id,
        current_streak,
        longest_streak,
        last_completed_date
    ) VALUES (
        NEW.id,
        0,
        0,
        NULL
    );

    RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user_registration();

-- 4.2 Streak State Machine Trigger
CREATE OR REPLACE FUNCTION public.process_daily_streak_increment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_streak RECORD;
    v_today DATE := CURRENT_DATE;
BEGIN
    -- Only evaluate on transition to satisfied completion threshold
    IF NEW.is_completed = true AND (OLD.is_completed IS DISTINCT FROM true) THEN
        
        -- Lock row for concurrency safety
        SELECT * INTO v_user_streak 
        FROM public.user_streaks 
        WHERE user_id = NEW.user_id 
        FOR UPDATE;

        IF v_user_streak.last_completed_date IS NULL THEN
            -- First completion ever
            UPDATE public.user_streaks
            SET current_streak = 1,
                longest_streak = GREATEST(longest_streak, 1),
                last_completed_date = v_today,
                updated_at = clock_timestamp()
            WHERE user_id = NEW.user_id;

        ELSIF v_user_streak.last_completed_date = v_today THEN
            -- Already preserved today's streak (idempotent ignore)
            NULL;

        ELSIF v_user_streak.last_completed_date = (v_today - INTERVAL '1 day')::date THEN
            -- Successive consecutive day: Increment
            UPDATE public.user_streaks
            SET current_streak = current_streak + 1,
                longest_streak = GREATEST(longest_streak, current_streak + 1),
                last_completed_date = v_today,
                updated_at = clock_timestamp()
            WHERE user_id = NEW.user_id;

        ELSE
            -- Streak broken: Reset to 1
            UPDATE public.user_streaks
            SET current_streak = 1,
                last_completed_date = v_today,
                updated_at = clock_timestamp()
            WHERE user_id = NEW.user_id;
        END IF;

        -- Update delivery entity status
        NEW.status = 'watched';
        NEW.watched_at = clock_timestamp();
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER on_delivery_progress_updated
    BEFORE UPDATE OF watch_duration_seconds ON public.user_feed_deliveries
    FOR EACH ROW
    EXECUTE FUNCTION public.process_daily_streak_increment();

-- 5. Row Level Security (RLS) Policies

-- 5.1 Enable RLS
ALTER TABLE public.subscription_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.niche_professions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generated_videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_feed_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_streaks ENABLE ROW LEVEL SECURITY;

-- Helper security functions
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid() AND role = 'admin'
    );
$$;

-- 5.2 Subscription Tiers Policies
CREATE POLICY "Public profiles can view active tiers"
    ON public.subscription_tiers FOR SELECT
    USING (is_active = true);

CREATE POLICY "Admin write access for subscription_tiers"
    ON public.subscription_tiers FOR ALL
    TO authenticated
    USING (public.is_admin());

-- 5.3 Niche Professions Policies
CREATE POLICY "Public read on active professions"
    ON public.niche_professions FOR SELECT
    USING (is_active = true);

CREATE POLICY "Admin write access for niche_professions"
    ON public.niche_professions FOR ALL
    TO authenticated
    USING (public.is_admin());

-- 5.4 Profiles Policies
CREATE POLICY "Users can view their own profile"
    ON public.profiles FOR SELECT
    TO authenticated
    USING (auth.uid() = id);

CREATE POLICY "Users can update specific columns of their profile"
    ON public.profiles FOR UPDATE
    TO authenticated
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

CREATE POLICY "Admin full access for profiles"
    ON public.profiles FOR ALL
    TO authenticated
    USING (public.is_admin());

-- 5.5 Topics Policies
CREATE POLICY "Topics accessible to active authenticated members"
    ON public.topics FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Admin manage topics"
    ON public.topics FOR ALL
    TO authenticated
    USING (public.is_admin());

-- 5.6 Generated Videos Policies
CREATE POLICY "View videos delivered to user"
    ON public.generated_videos FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.user_feed_deliveries ufd
            WHERE ufd.video_id = public.generated_videos.id
            AND ufd.user_id = auth.uid()
        )
        OR public.is_admin()
    );

CREATE POLICY "Service roles and admins manage generated_videos"
    ON public.generated_videos FOR ALL
    TO authenticated
    USING (public.is_admin());

-- 5.7 User Feed Deliveries Policies
CREATE POLICY "Users can read own feed deliveries"
    ON public.user_feed_deliveries FOR SELECT
    TO authenticated
    USING (user_id = auth.uid());

CREATE POLICY "Users can update watch progress on own deliveries"
    ON public.user_feed_deliveries FOR UPDATE
    TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "Admin and ingest workers insert deliveries"
    ON public.user_feed_deliveries FOR INSERT
    TO authenticated
    WITH CHECK (public.is_admin());

-- 5.8 User Streaks Policies
CREATE POLICY "Users can view own streaks"
    ON public.user_streaks FOR SELECT
    TO authenticated
    USING (user_id = auth.uid());

CREATE POLICY "Admin can update streaks"
    ON public.user_streaks FOR ALL
    TO authenticated
    USING (public.is_admin());

-- 6. Storage Bucket Configuration & Storage Policies

-- Insert storage buckets (requires storage schema to be available)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES 
    ('learning-videos', 'learning-videos', false, 52428800, ARRAY['video/mp4', 'application/x-mpegURL', 'video/MP2T']),
    ('learning-thumbnails', 'learning-thumbnails', false, 5242880, ARRAY['image/webp', 'image/jpeg', 'image/png'])
ON CONFLICT (id) DO NOTHING;

-- Enforce access via storage.objects policies

-- 6.1 Learning Videos Access
CREATE POLICY "Stream delivery videos based on feed entitlement"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (
        bucket_id = 'learning-videos'
        AND (
            EXISTS (
                SELECT 1
                FROM public.user_feed_deliveries ufd
                JOIN public.generated_videos gv ON ufd.video_id = gv.id
                WHERE ufd.user_id = auth.uid()
                AND gv.video_storage_path = storage.objects.name
            )
            OR public.is_admin()
        )
    );

-- 6.2 Learning Thumbnails Access
CREATE POLICY "Read thumbnails based on feed entitlement"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (
        bucket_id = 'learning-thumbnails'
        AND (
            EXISTS (
                SELECT 1
                FROM public.user_feed_deliveries ufd
                JOIN public.generated_videos gv ON ufd.video_id = gv.id
                WHERE ufd.user_id = auth.uid()
                AND gv.thumbnail_storage_path = storage.objects.name
            )
            OR public.is_admin()
        )
    );

-- 6.3 Admin and Pipeline Service Write Policies
CREATE POLICY "Ingestion service upload videos"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (
        bucket_id IN ('learning-videos', 'learning-thumbnails')
        AND public.is_admin()
    );

CREATE POLICY "Ingestion service update delete assets"
    ON storage.objects FOR ALL
    TO authenticated
    USING (
        bucket_id IN ('learning-videos', 'learning-thumbnails')
        AND public.is_admin()
    );

-- 7. Performance Optimization & Seed Scaffolding

-- Seed Initial Base Tiers
INSERT INTO public.subscription_tiers (name, slug, daily_video_limit, max_professions, features)
VALUES 
    ('Solopreneur Free', 'free', 1, 1, '{"captions": true, "audio_speed": false}'::jsonb),
    ('Solopreneur Pro', 'pro', 3, 3, '{"captions": true, "audio_speed": true, "offline_downloads": true}'::jsonb)
ON CONFLICT (slug) DO NOTHING;

-- Seed Initial High-Value Solopreneur Professions
INSERT INTO public.niche_professions (slug, title, description)
VALUES 
    ('b2b-copywriter', 'B2B Copywriter', 'Conversion rate optimization, cold email sequences, and landing page frameworks.'),
    ('indie-hacker', 'Technical Solopreneur', 'SaaS architecture, micro-funnels, rapid prototyping, and API monetization.'),
    ('notion-consultant', 'Notion Solutions Architect', 'Enterprise workflow design, template monetization, and client onboarding.')
ON CONFLICT (slug) DO NOTHING;
