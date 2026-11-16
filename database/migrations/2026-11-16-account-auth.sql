CREATE TABLE IF NOT EXISTS public.app_users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.auth_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.build_jobs ADD COLUMN IF NOT EXISTS user_id text REFERENCES public.app_users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS app_users_email_idx ON public.app_users(email);
CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx ON public.auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx ON public.auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS build_jobs_user_created_idx ON public.build_jobs(user_id, created_at DESC);
