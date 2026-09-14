
-- Speed test history for internet connections
CREATE TABLE IF NOT EXISTS speed_test_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  internet_id uuid NOT NULL REFERENCES ict_internet(id) ON DELETE CASCADE,
  tested_at   timestamptz NOT NULL DEFAULT now(),
  dl_mbps     numeric(10,2) NOT NULL,
  ul_mbps     numeric(10,2),
  latency_ms  integer,
  notes       text,
  tested_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_speed_test_logs_internet_id ON speed_test_logs(internet_id);
CREATE INDEX IF NOT EXISTS idx_speed_test_logs_tested_at   ON speed_test_logs(tested_at DESC);

ALTER TABLE speed_test_logs ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read logs
CREATE POLICY "speed_test_logs_select" ON speed_test_logs
  FOR SELECT TO authenticated USING (true);

-- IT Admin / Sysadmin can insert
CREATE POLICY "speed_test_logs_insert" ON speed_test_logs
  FOR INSERT TO authenticated
  WITH CHECK (is_ict_admin());

-- IT Admin / Sysadmin can delete
CREATE POLICY "speed_test_logs_delete" ON speed_test_logs
  FOR DELETE TO authenticated
  USING (is_ict_admin());
