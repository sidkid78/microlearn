-- ============================================================================
-- 1. EXTENSIONS & TYPES
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_net";

DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('member', 'admin', 'service_role');
    CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'past_due', 'canceled', 'unpaid');
    CREATE TYPE video_generation_status AS ENUM ('pending', 'scripting', 'rendering', 'ready', 'failed');
    CREATE TYPE delivery_status AS ENUM ('queued', 'delivered', 'watched', 'skipped');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ============================================================================
-- 2. TABLE DEFINITIONS
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.subscription_tiers (
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

CREATE TABLE IF NOT EXISTS public.niche_professions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(60) NOT NULL UNIQUE,
    title VARCHAR(100) NOT NULL,
    description TEXT,
    icon_url TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS public.profiles (
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

CREATE TABLE IF NOT EXISTS public.topics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profession_id UUID NOT NULL REFERENCES public.niche_professions(id) ON DELETE CASCADE,
    title VARCHAR(150) NOT NULL,
    category VARCHAR(50) NOT NULL,
    difficulty_level SMALLINT NOT NULL DEFAULT 1 CHECK (difficulty_level BETWEEN 1 AND 5),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS public.generated_videos (
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

CREATE TABLE IF NOT EXISTS public.user_feed_deliveries (
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

CREATE TABLE IF NOT EXISTS public.user_streaks (
    user_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    current_streak INT NOT NULL DEFAULT 0,
    longest_streak INT NOT NULL DEFAULT 0,
    last_completed_date DATE,
    freeze_tokens_remaining SMALLINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Indexes for scale
CREATE INDEX IF NOT EXISTS idx_profiles_delivery ON public.profiles(delivery_hour_utc, subscription_status);
CREATE INDEX IF NOT EXISTS idx_deliveries_user_date ON public.user_feed_deliveries(user_id, scheduled_for DESC);
CREATE INDEX IF NOT EXISTS idx_videos_ready ON public.generated_videos(topic_id) WHERE generation_status = 'ready';

-- ============================================================================
-- 3. STATE MACHINES & BUSINESS TRIGGERS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user_registration()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_tier_id UUID;
    v_prof_id UUID;
BEGIN
    SELECT id INTO v_tier_id FROM public.subscription_tiers WHERE slug = 'free' LIMIT 1;
    SELECT id INTO v_prof_id FROM public.niche_professions WHERE is_active = true ORDER BY created_at ASC LIMIT 1;

    INSERT INTO public.profiles (
        id, email, full_name, avatar_url, tier_id, selected_profession_id, subscription_status
    ) VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'full_name', 'Solopreneur'),
        NEW.raw_user_meta_data->>'avatar_url',
        v_tier_id,
        COALESCE((NEW.raw_user_meta_data->>'profession_id')::uuid, v_prof_id),
        'trialing'
    );

    INSERT INTO public.user_streaks (user_id, current_streak, longest_streak)
    VALUES (NEW.id, 0, 0);

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_registration();

CREATE OR REPLACE FUNCTION public.process_daily_streak_increment()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_streak RECORD;
    v_today DATE := CURRENT_DATE;
BEGIN
    IF NEW.is_completed = true AND (OLD.is_completed IS DISTINCT FROM true) THEN
        SELECT * INTO v_streak FROM public.user_streaks WHERE user_id = NEW.user_id FOR UPDATE;

        IF v_streak.last_completed_date IS NULL THEN
            UPDATE public.user_streaks
            SET current_streak = 1, longest_streak = 1, last_completed_date = v_today, updated_at = clock_timestamp()
            WHERE user_id = NEW.user_id;
        ELSIF v_streak.last_completed_date = v_today THEN
            -- Idempotent protection
            NULL;
        ELSIF v_streak.last_completed_date = (v_today - INTERVAL '1 day')::date THEN
            UPDATE public.user_streaks
            SET current_streak = current_streak + 1,
                longest_streak = GREATEST(longest_streak, current_streak + 1),
                last_completed_date = v_today,
                updated_at = clock_timestamp()
            WHERE user_id = NEW.user_id;
        ELSE
            UPDATE public.user_streaks
            SET current_streak = 1, last_completed_date = v_today, updated_at = clock_timestamp()
            WHERE user_id = NEW.user_id;
        END IF;

        NEW.status = 'watched';
        NEW.watched_at = clock_timestamp();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_delivery_progress_updated ON public.user_feed_deliveries;
CREATE TRIGGER on_delivery_progress_updated
    BEFORE UPDATE OF watch_duration_seconds ON public.user_feed_deliveries
    FOR EACH ROW EXECUTE FUNCTION public.process_daily_streak_increment();

-- ============================================================================
-- 4. ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================
ALTER TABLE public.subscription_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.niche_professions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generated_videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_feed_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_streaks ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin');
$$;

-- Subscription Tiers & Professions
CREATE POLICY "Public can read tiers" ON public.subscription_tiers FOR SELECT USING (is_active = true);
CREATE POLICY "Public can read professions" ON public.niche_professions FOR SELECT USING (is_active = true);

-- Profiles
CREATE POLICY "Users read own profile" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "Users update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- Feed Deliveries
CREATE POLICY "Users read own deliveries" ON public.user_feed_deliveries FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users update own delivery progress" ON public.user_feed_deliveries FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Videos: Strict entitlement linkage (User can only read if explicitly assigned)
CREATE POLICY "Read videos assigned in feed" ON public.generated_videos FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.user_feed_deliveries ufd WHERE ufd.video_id = public.generated_videos.id AND ufd.user_id = auth.uid()) OR public.is_admin()
);

-- Streaks
CREATE POLICY "Users read own streaks" ON public.user_streaks FOR SELECT TO authenticated USING (user_id = auth.uid());

-- Admin blanket overrides
CREATE POLICY "Admins full manage profiles" ON public.profiles FOR ALL TO authenticated USING (public.is_admin());
CREATE POLICY "Admins full manage videos" ON public.generated_videos FOR ALL TO authenticated USING (public.is_admin());
CREATE POLICY "Admins full manage deliveries" ON public.user_feed_deliveries FOR ALL TO authenticated USING (public.is_admin());

-- ============================================================================
-- 5. STORAGE BUCKETS SETUP
-- ============================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES 
    ('learning-videos', 'learning-videos', false, 52428800, ARRAY['video/mp4', 'application/x-mpegURL', 'video/MP2T']),
    ('learning-thumbnails', 'learning-thumbnails', false, 5242880, ARRAY['image/webp', 'image/jpeg', 'image/png'])
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Users read permitted video assets" ON storage.objects FOR SELECT TO authenticated USING (
    bucket_id = 'learning-videos' AND (
        EXISTS (
            SELECT 1 FROM public.user_feed_deliveries ufd
            JOIN public.generated_videos gv ON ufd.video_id = gv.id
            WHERE ufd.user_id = auth.uid() AND gv.video_storage_path = storage.objects.name
        ) OR public.is_admin()
    )
);

CREATE POLICY "Users read permitted thumbnail assets" ON storage.objects FOR SELECT TO authenticated USING (
    bucket_id = 'learning-thumbnails' AND (
        EXISTS (
            SELECT 1 FROM public.user_feed_deliveries ufd
            JOIN public.generated_videos gv ON ufd.video_id = gv.id
            WHERE ufd.user_id = auth.uid() AND gv.thumbnail_storage_path = storage.objects.name
        ) OR public.is_admin()
    )
);

-- ============================================================================
-- 6. SYSTEM SEEDS
-- ============================================================================
INSERT INTO public.subscription_tiers (name, slug, daily_video_limit, max_professions)
VALUES 
    ('Free Trial', 'free', 1, 1),
    ('Pro Solopreneur', 'pro', 3, 3)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.niche_professions (slug, title, description)
VALUES 
    ('b2b-copywriter', 'B2B Copywriter', 'Conversion rate optimization, cold outbound scripts, and VSL frameworks.'),
    ('indie-hacker', 'Indie Hacker / Micro-SaaS', 'Micro-SaaS validation, rapid MVP architecture, distribution, and Stripe metrics.'),
    ('notion-architect', 'Notion Solutions Architect', 'Enterprise Notion databases, client portals, and commercial template scaling.')
ON CONFLICT (slug) DO NOTHING;
