ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';
CREATE TABLE IF NOT EXISTS public.compiler_admin_settings (
 id integer PRIMARY KEY DEFAULT 1 CHECK (id=1),
 registration_enabled boolean NOT NULL DEFAULT true,
 builds_enabled boolean NOT NULL DEFAULT true,
 maintenance_mode boolean NOT NULL DEFAULT false,
 max_upload_mb integer NOT NULL DEFAULT 50 CHECK (max_upload_mb BETWEEN 1 AND 500),
 max_concurrent_builds integer NOT NULL DEFAULT 3 CHECK (max_concurrent_builds BETWEEN 1 AND 20),
 build_timeout_minutes integer NOT NULL DEFAULT 45 CHECK (build_timeout_minutes BETWEEN 5 AND 180),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid
);
INSERT INTO public.compiler_admin_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.compiler_announcements (
 id bigserial PRIMARY KEY, title text NOT NULL, body text NOT NULL,
 audience text NOT NULL DEFAULT 'all', created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
 active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS public.compiler_admin_audit_logs (
 id bigserial PRIMARY KEY, actor_id uuid, actor_email text, action text NOT NULL,
 target_type text, target_id text, details jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.compiler_app_versions (
 id integer PRIMARY KEY DEFAULT 1 CHECK (id=1), latest_version text NOT NULL DEFAULT '1.0.0',
 minimum_version text NOT NULL DEFAULT '1.0.0', force_update boolean NOT NULL DEFAULT false,
 updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.compiler_app_versions (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.compiler_support_tickets (
 id bigserial PRIMARY KEY, user_id uuid, subject text NOT NULL, body text NOT NULL,
 status text NOT NULL DEFAULT 'open', assigned_to uuid, response text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS compiler_admin_audit_created_idx ON public.compiler_admin_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS compiler_announcements_created_idx ON public.compiler_announcements(created_at DESC);
CREATE INDEX IF NOT EXISTS compiler_support_status_idx ON public.compiler_support_tickets(status,created_at DESC);
-- Safe bootstrap: promotes the existing account only if it already exists; does not create an account or change its password.
UPDATE public.app_users SET role='super_admin' WHERE lower(email)='shakda256@gmail.com';