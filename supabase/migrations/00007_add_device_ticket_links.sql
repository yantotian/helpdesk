
-- Link ICT devices to support tickets
CREATE TABLE IF NOT EXISTS device_ticket_links (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id  uuid NOT NULL REFERENCES ict_devices(id) ON DELETE CASCADE,
  ticket_id  uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  linked_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(device_id, ticket_id)
);

CREATE INDEX IF NOT EXISTS idx_dtl_device_id ON device_ticket_links(device_id);
CREATE INDEX IF NOT EXISTS idx_dtl_ticket_id ON device_ticket_links(ticket_id);

ALTER TABLE device_ticket_links ENABLE ROW LEVEL SECURITY;

-- All authenticated users can view links
CREATE POLICY "dtl_select" ON device_ticket_links
  FOR SELECT TO authenticated USING (true);

-- IT Admin / Sysadmin can insert
CREATE POLICY "dtl_insert" ON device_ticket_links
  FOR INSERT TO authenticated
  WITH CHECK (is_ict_admin());

-- IT Admin / Sysadmin can delete
CREATE POLICY "dtl_delete" ON device_ticket_links
  FOR DELETE TO authenticated
  USING (is_ict_admin());
