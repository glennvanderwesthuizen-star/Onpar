-- Phase 1 of the optimisation review (owner, 9 Oct 2026; D-54).

-- Photos on tasks, reports and Wire notes: removed after the period (12 months), the record stays.
ALTER TABLE retention_settings ADD COLUMN record_photo_months integer NOT NULL DEFAULT 12 CHECK (record_photo_months BETWEEN 1 AND 120);
-- A domestic worker's entry snapshot when the photos clearly matched: kept 30 days ("thirty days is enough").
-- Snapshots in doubt are kept with the visitor photos, as evidence.
ALTER TABLE retention_settings ADD COLUMN staff_snapshot_days integer NOT NULL DEFAULT 30 CHECK (staff_snapshot_days BETWEEN 1 AND 3650);

ALTER TABLE retention_log DROP CONSTRAINT retention_log_kind_check;
ALTER TABLE retention_log ADD CONSTRAINT retention_log_kind_check
  CHECK (kind IN ('selfie','patrol_photo','bolo_media','visit_photo','visit_document','visit_exception_photo','visitor_person','visitor_vehicle','visitor_pass',
                  'task_photo','report_photo','wire_photo','staff_snapshot'));

-- The per-site "months visitor records are kept" was never used: the company setting on the
-- Privacy page is the one that works.
ALTER TABLE site_visitor_settings DROP COLUMN retention_months;

-- Nightly clean-up of things that grow forever and are not records. The real record of each
-- event stays in its own history and the audit log. Runs for every company at once, so it is
-- a definer function the app may call but not change.
CREATE FUNCTION housekeeping() RETURNS TABLE (alerts integer, deliveries integer, sign_in_counters integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a integer; d integer; t integer;
BEGIN
  -- Delivery records of alerts: 30 days.
  DELETE FROM notification_deliveries WHERE at < now() - interval '30 days';
  GET DIAGNOSTICS d = ROW_COUNT;
  -- Alerts themselves: one year (owner: records kept one year).
  DELETE FROM notifications WHERE created_at < now() - interval '12 months';
  GET DIAGNOSTICS a = ROW_COUNT;
  -- Failed sign-in counters not locked and older than a week.
  DELETE FROM auth_throttle WHERE window_start < now() - interval '7 days' AND (locked_until IS NULL OR locked_until < now());
  GET DIAGNOSTICS t = ROW_COUNT;
  RETURN QUERY SELECT a, d, t;
END $$;
REVOKE ALL ON FUNCTION housekeeping() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION housekeeping() TO onpar_app;
