
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Enums
CREATE TYPE public.user_role AS ENUM ('requester', 'technician', 'it_admin', 'sysadmin');
CREATE TYPE public.ticket_status AS ENUM ('new', 'assigned', 'in_progress', 'resolved', 'on_hold', 'verified', 'closed');
CREATE TYPE public.ticket_priority AS ENUM ('low', 'medium', 'high', 'critical');

-- Profiles table
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username text UNIQUE NOT NULL,
  email text UNIQUE,
  full_name text,
  role public.user_role NOT NULL DEFAULT 'requester',
  office text,
  contact text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Categories
CREATE TABLE public.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  parent_id uuid REFERENCES public.categories(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Priority config (SLA hours)
CREATE TABLE public.priority_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  priority public.ticket_priority UNIQUE NOT NULL,
  label text NOT NULL,
  sla_hours int NOT NULL,
  color text NOT NULL DEFAULT '#888888'
);

-- Tickets
CREATE TABLE public.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number text UNIQUE NOT NULL,
  requester_id uuid NOT NULL REFERENCES public.profiles(id),
  office text,
  contact text,
  category_id uuid REFERENCES public.categories(id),
  subcategory_id uuid REFERENCES public.categories(id),
  priority public.ticket_priority NOT NULL DEFAULT 'medium',
  subject text NOT NULL,
  description text,
  location text,
  assigned_to uuid REFERENCES public.profiles(id),
  status public.ticket_status NOT NULL DEFAULT 'new',
  resolution text,
  resolved_at timestamptz,
  sla_due_at timestamptz,
  sla_breached boolean NOT NULL DEFAULT false,
  sla_alert_sent boolean NOT NULL DEFAULT false,
  auto_close_at timestamptz,
  remarks text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Ticket activities (comments, status changes, etc.)
CREATE TABLE public.ticket_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES public.profiles(id),
  activity_type text NOT NULL, -- 'comment', 'status_change', 'assignment', 'resolution', 'attachment', 'system'
  content text,
  old_value text,
  new_value text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Attachments
CREATE TABLE public.ticket_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  uploader_id uuid NOT NULL REFERENCES public.profiles(id),
  file_name text NOT NULL,
  file_path text NOT NULL,
  file_size bigint,
  mime_type text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Audit log
CREATE TABLE public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES public.profiles(id),
  table_name text NOT NULL,
  record_id text NOT NULL,
  action text NOT NULL,
  old_data jsonb,
  new_data jsonb,
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- System config
CREATE TABLE public.system_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  description text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Ticket number sequence per year
CREATE SEQUENCE public.ticket_seq START 1;

-- Auto-generate ticket number
CREATE OR REPLACE FUNCTION generate_ticket_number()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  yr text;
  seq_val bigint;
BEGIN
  yr := to_char(now(), 'YYYY');
  seq_val := nextval('public.ticket_seq');
  NEW.ticket_number := 'TKT-' || yr || '-' || lpad(seq_val::text, 5, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ticket_number
  BEFORE INSERT ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION generate_ticket_number();

-- Update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tickets_updated_at BEFORE UPDATE ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_profiles_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Auto-set SLA due date on ticket insert
CREATE OR REPLACE FUNCTION set_sla_due()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sla_h int;
BEGIN
  SELECT sla_hours INTO sla_h FROM public.priority_config WHERE priority = NEW.priority;
  IF sla_h IS NOT NULL THEN
    NEW.sla_due_at := now() + (sla_h || ' hours')::interval;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sla_due
  BEFORE INSERT ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION set_sla_due();

-- Set auto-close timestamp when ticket moves to verified
CREATE OR REPLACE FUNCTION set_auto_close()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'verified' AND (OLD.status IS DISTINCT FROM 'verified') THEN
    NEW.auto_close_at := now() + interval '48 hours';
  END IF;
  IF NEW.status != 'verified' THEN
    NEW.auto_close_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auto_close
  BEFORE UPDATE ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION set_auto_close();

-- Handle new user registration (trigger on auth.users)
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, username, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'username', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    COALESCE((NEW.raw_user_meta_data->>'role')::public.user_role, 'requester')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- SECURITY DEFINER helper: get current user role
CREATE OR REPLACE FUNCTION get_user_role(uid uuid)
RETURNS public.user_role LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM public.profiles WHERE id = uid;
$$;

-- Helper: check if user is admin level
CREATE OR REPLACE FUNCTION is_admin(uid uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT role IN ('it_admin', 'sysadmin') FROM public.profiles WHERE id = uid;
$$;

-- Helper: check if user is sysadmin
CREATE OR REPLACE FUNCTION is_sysadmin(uid uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT role = 'sysadmin' FROM public.profiles WHERE id = uid;
$$;

-- Helper: get ticket requester
CREATE OR REPLACE FUNCTION ticket_requester(ticket_id uuid)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT requester_id FROM public.tickets WHERE id = ticket_id;
$$;

-- Helper: get ticket assigned_to
CREATE OR REPLACE FUNCTION ticket_assigned_to(ticket_id uuid)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT assigned_to FROM public.tickets WHERE id = ticket_id;
$$;

-- RLS: profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access to profiles" ON public.profiles
  FOR ALL TO authenticated USING (is_admin(auth.uid()));

CREATE POLICY "Users view own profile" ON public.profiles
  FOR SELECT TO authenticated USING (auth.uid() = id);

CREATE POLICY "Users update own profile (not role)" ON public.profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id)
  WITH CHECK (role IS NOT DISTINCT FROM get_user_role(auth.uid()));

-- RLS: categories (public read, admin write)
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read active categories" ON public.categories
  FOR SELECT TO authenticated USING (is_active = true OR is_admin(auth.uid()));

CREATE POLICY "Admin manage categories" ON public.categories
  FOR ALL TO authenticated USING (is_admin(auth.uid()));

-- RLS: priority_config (public read, admin write)
ALTER TABLE public.priority_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone reads priority_config" ON public.priority_config
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admin manages priority_config" ON public.priority_config
  FOR ALL TO authenticated USING (is_admin(auth.uid()));

-- RLS: tickets
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Requester sees own tickets" ON public.tickets
  FOR SELECT TO authenticated
  USING (
    requester_id = auth.uid()
    OR assigned_to = auth.uid()
    OR is_admin(auth.uid())
  );

CREATE POLICY "Requester creates tickets" ON public.tickets
  FOR INSERT TO authenticated
  WITH CHECK (requester_id = auth.uid());

CREATE POLICY "Technician updates assigned tickets" ON public.tickets
  FOR UPDATE TO authenticated
  USING (
    assigned_to = auth.uid()
    OR is_admin(auth.uid())
    OR requester_id = auth.uid()
  );

CREATE POLICY "Admin full ticket access" ON public.tickets
  FOR ALL TO authenticated USING (is_admin(auth.uid()));

-- RLS: ticket_activities
ALTER TABLE public.ticket_activities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Can read activities for accessible tickets" ON public.ticket_activities
  FOR SELECT TO authenticated
  USING (
    ticket_requester(ticket_id) = auth.uid()
    OR ticket_assigned_to(ticket_id) = auth.uid()
    OR is_admin(auth.uid())
  );

CREATE POLICY "Can insert activities for accessible tickets" ON public.ticket_activities
  FOR INSERT TO authenticated
  WITH CHECK (
    actor_id = auth.uid()
    AND (
      ticket_requester(ticket_id) = auth.uid()
      OR ticket_assigned_to(ticket_id) = auth.uid()
      OR is_admin(auth.uid())
    )
  );

-- RLS: ticket_attachments
ALTER TABLE public.ticket_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Access attachments for accessible tickets" ON public.ticket_attachments
  FOR SELECT TO authenticated
  USING (
    uploader_id = auth.uid()
    OR ticket_requester(ticket_id) = auth.uid()
    OR ticket_assigned_to(ticket_id) = auth.uid()
    OR is_admin(auth.uid())
  );

CREATE POLICY "Upload attachments for accessible tickets" ON public.ticket_attachments
  FOR INSERT TO authenticated
  WITH CHECK (
    uploader_id = auth.uid()
    AND (
      ticket_requester(ticket_id) = auth.uid()
      OR ticket_assigned_to(ticket_id) = auth.uid()
      OR is_admin(auth.uid())
    )
  );

-- RLS: audit_log (admin read-only)
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read audit log" ON public.audit_log
  FOR SELECT TO authenticated USING (is_admin(auth.uid()));

CREATE POLICY "System inserts audit log" ON public.audit_log
  FOR INSERT TO authenticated WITH CHECK (true);

-- RLS: system_config (admin read/write, sysadmin write)
ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin reads config" ON public.system_config
  FOR SELECT TO authenticated USING (is_admin(auth.uid()));

CREATE POLICY "Sysadmin manages config" ON public.system_config
  FOR ALL TO authenticated USING (is_sysadmin(auth.uid()));

-- Storage bucket for attachments
INSERT INTO storage.buckets (id, name, public) VALUES ('ticket-attachments', 'ticket-attachments', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Authenticated upload attachments" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'ticket-attachments');

CREATE POLICY "Authenticated access attachments" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'ticket-attachments');

-- Seed: categories
INSERT INTO public.categories (name, parent_id, is_active, sort_order) VALUES
  ('Hardware', NULL, true, 1),
  ('Software', NULL, true, 2),
  ('Network', NULL, true, 3),
  ('Email', NULL, true, 4),
  ('Printer', NULL, true, 5),
  ('Account', NULL, true, 6),
  ('Server', NULL, true, 7),
  ('Mobile', NULL, true, 8),
  ('WiFi', NULL, true, 9),
  ('Website', NULL, true, 10),
  ('IS', NULL, true, 11),
  ('Other', NULL, true, 12);

-- Seed subcategories
DO $$
DECLARE
  hw_id uuid; sw_id uuid; net_id uuid; acc_id uuid; srv_id uuid; mob_id uuid;
BEGIN
  SELECT id INTO hw_id FROM public.categories WHERE name = 'Hardware' AND parent_id IS NULL;
  SELECT id INTO sw_id FROM public.categories WHERE name = 'Software' AND parent_id IS NULL;
  SELECT id INTO net_id FROM public.categories WHERE name = 'Network' AND parent_id IS NULL;
  SELECT id INTO acc_id FROM public.categories WHERE name = 'Account' AND parent_id IS NULL;
  SELECT id INTO srv_id FROM public.categories WHERE name = 'Server' AND parent_id IS NULL;
  SELECT id INTO mob_id FROM public.categories WHERE name = 'Mobile' AND parent_id IS NULL;

  INSERT INTO public.categories (name, parent_id, is_active, sort_order) VALUES
    ('Desktop/Laptop', hw_id, true, 1),
    ('Keyboard/Mouse', hw_id, true, 2),
    ('Monitor', hw_id, true, 3),
    ('UPS/Power', hw_id, true, 4),
    ('Installation', sw_id, true, 1),
    ('Update/Patch', sw_id, true, 2),
    ('License', sw_id, true, 3),
    ('Bug/Error', sw_id, true, 4),
    ('LAN', net_id, true, 1),
    ('VPN', net_id, true, 2),
    ('Firewall', net_id, true, 3),
    ('Password Reset', acc_id, true, 1),
    ('New Account', acc_id, true, 2),
    ('Permissions', acc_id, true, 3),
    ('Windows Server', srv_id, true, 1),
    ('Linux Server', srv_id, true, 2),
    ('iOS', mob_id, true, 1),
    ('Android', mob_id, true, 2);
END;
$$;

-- Seed: priority config
INSERT INTO public.priority_config (priority, label, sla_hours, color) VALUES
  ('low', 'Low', 48, '#888888'),
  ('medium', 'Medium', 24, '#4A90D9'),
  ('high', 'High', 8, '#F5A623'),
  ('critical', 'Critical', 4, '#FF4500')
ON CONFLICT (priority) DO UPDATE SET sla_hours = EXCLUDED.sla_hours, label = EXCLUDED.label, color = EXCLUDED.color;

-- Seed: system config
INSERT INTO public.system_config (key, value, description) VALUES
  ('auto_close_hours', '48', 'Hours after Verified status before auto-close'),
  ('sla_alert_email', 'itadmin@company.com', 'Email for SLA breach alerts'),
  ('auto_assign_enabled', 'true', 'Enable auto-assignment to least-busy technician'),
  ('rate_limit_per_minute', '60', 'API rate limit per minute per user')
ON CONFLICT (key) DO NOTHING;

-- Public view for profiles (safe to share)
CREATE VIEW public.public_profiles AS
  SELECT id, username, full_name, role, office, is_active FROM public.profiles;

-- pg_cron: auto-close verified tickets after 48h (every 15 minutes)
SELECT cron.schedule(
  'auto-close-verified-tickets',
  '*/15 * * * *',
  $$
  UPDATE public.tickets
  SET status = 'closed', updated_at = now()
  WHERE status = 'verified'
    AND auto_close_at IS NOT NULL
    AND auto_close_at <= now();
  $$
);

-- pg_cron: SLA breach check (every 5 minutes) - updates flag and queues alert via Edge Function
SELECT cron.schedule(
  'sla-breach-check',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/sla-checker',
    headers := jsonb_build_object(
      'Content-type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
    ),
    body := '{"trigger":"cron"}'::jsonb
  ) as request_id;
  $$
);
