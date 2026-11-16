-- Apply once to the APK Compiler Neon database (not the Factory Enc database).
ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';
ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
CREATE TABLE IF NOT EXISTS public.compiler_admin_settings (
 id integer PRIMARY KEY DEFAULT 1 CHECK (id=1),
 maintenance_mode boolean NOT NULL DEFAULT false,
 registration_enabled boolean NOT NULL DEFAULT true,
 builds_enabled boolean NOT NULL DEFAULT true,
 max_upload_mb integer NOT NULL DEFAULT 50 CHECK (max_upload_mb BETWEEN 1 AND 500),
 max_concurrent_builds integer NOT NULL DEFAULT 3 CHECK (max_concurrent_builds BETWEEN 1 AND 20),
 build_timeout_minutes integer NOT NULL DEFAULT 45 CHECK (build_timeout_minutes BETWEEN 5 AND 180),
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid
);
INSERT INTO public.compiler_admin_settings(id) VALUES(1) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.compiler_feature_flags (
 feature_key text PRIMARY KEY, enabled boolean NOT NULL DEFAULT true,
 description text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid
);
INSERT INTO public.compiler_feature_flags(feature_key,enabled,description) VALUES
 ('gradle_builds',true,'Build Android Gradle projects'),
 ('flutter_builds',true,'Build Flutter projects'),
 ('debug_outputs',true,'Allow debug APK and AAB outputs'),
 ('release_outputs',true,'Allow release APK and AAB outputs'),
 ('artifact_downloads',true,'Allow users to download build artifacts')
ON CONFLICT(feature_key) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.compiler_announcements (
 id bigserial PRIMARY KEY, title text NOT NULL, body text NOT NULL,
 audience text NOT NULL DEFAULT 'all' CHECK(audience IN ('all','selected')),
 target_user_ids uuid[] NOT NULL DEFAULT '{}', kind text NOT NULL DEFAULT 'info',
 active boolean NOT NULL DEFAULT true, starts_at timestamptz NOT NULL DEFAULT now(),
 ends_at timestamptz, created_by uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.compiler_admin_audit_logs (
 id bigserial PRIMARY KEY, actor_user_id uuid, actor_email text, action text NOT NULL,
 target_type text, target_id text, details jsonb NOT NULL DEFAULT '{}'::jsonb,
 ip_address text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS compiler_admin_audit_created_idx ON public.compiler_admin_audit_logs(created_at DESC);
CREATE TABLE IF NOT EXISTS public.compiler_app_versions (
 id bigserial PRIMARY KEY, platform text NOT NULL DEFAULT 'android', version_name text NOT NULL,
 version_code integer NOT NULL, minimum_supported_code integer NOT NULL DEFAULT 1,
 download_url text, release_notes text NOT NULL DEFAULT '', force_update boolean NOT NULL DEFAULT false,
 active boolean NOT NULL DEFAULT true, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(platform,version_code)
);
CREATE TABLE IF NOT EXISTS public.compiler_support_tickets (
 id bigserial PRIMARY KEY, user_id uuid, subject text NOT NULL, message text NOT NULL,
 status text NOT NULL DEFAULT 'open', priority text NOT NULL DEFAULT 'normal',
 assigned_to uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS compiler_announcements_created_idx ON public.compiler_announcements(created_at DESC);
CREATE INDEX IF NOT EXISTS compiler_support_status_idx ON public.compiler_support_tickets(status,created_at DESC);
-- Safe bootstrap: promotes this account only if it already exists; does not create an account or change its password.
UPDATE public.app_users SET role='super_admin',status='active' WHERE lower(email)=lower('shakda256@gmail.com');