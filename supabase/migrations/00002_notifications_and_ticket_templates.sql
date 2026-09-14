
-- ── Notifications ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  ticket_id     uuid REFERENCES tickets(id) ON DELETE CASCADE,
  type          text NOT NULL CHECK (type IN ('sla_breach','assignment','comment','status_change','system')),
  title         text NOT NULL,
  body          text,
  is_read       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_unread
  ON notifications(user_id, is_read, created_at DESC);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Users see only their own notifications
CREATE POLICY "own notifications" ON notifications
  FOR ALL USING (user_id = auth.uid());

-- ── Ticket Templates ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ticket_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  description   text,
  category_id   uuid REFERENCES categories(id) ON DELETE SET NULL,
  subcategory_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  priority      text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  subject       text NOT NULL DEFAULT '',
  body          text NOT NULL DEFAULT '',
  is_active     boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ticket_templates ENABLE ROW LEVEL SECURITY;

-- Everyone can read active templates
CREATE POLICY "read active templates" ON ticket_templates
  FOR SELECT USING (is_active = true);

-- Admins can manage templates
CREATE POLICY "admins manage templates" ON ticket_templates
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
      AND role IN ('it_admin','sysadmin')
    )
  );

-- Seed 3 example templates (safe — won't error if categories don't exist)
INSERT INTO ticket_templates (name, description, priority, subject, body, is_active)
VALUES
  ('Password Reset',    'Standard password reset request',  'low',    'Password Reset Request',         'Please reset my account password. My username is: [username]\nDepartment: [department]', true),
  ('New PC Setup',      'New employee workstation setup',   'medium', 'New Workstation Setup Required', 'A new workstation needs to be set up for:\nEmployee Name: [name]\nDepartment: [department]\nRequired software: [list software]\nStart date: [date]', true),
  ('Network Issue',     'Cannot connect to network/VPN',    'high',   'Network Connectivity Issue',     'I am unable to connect to the network.\nLocation: [office/floor]\nDevice: [device name/model]\nError message (if any): [error]\nSince when: [date/time]', true)
ON CONFLICT DO NOTHING;
