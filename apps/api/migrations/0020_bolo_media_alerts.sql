-- BOLO, second version (owner's decision 3 Oct 2026, docs/NEXT_ROUND.md item 12):
-- photo, video (up to 30 seconds), voice note and a written note in one BOLO; an orange
-- alert on the website that a manager or supervisor acknowledges and closes with a note;
-- points only at a manager's discretion (once per BOLO).

ALTER TABLE bolos
  ALTER COLUMN note SET DEFAULT '',
  ADD COLUMN voice_key           text,
  ADD COLUMN voice_content_type  text,
  ADD COLUMN video_key           text,
  ADD COLUMN video_content_type  text,
  ADD COLUMN acknowledged_at     timestamptz,
  ADD COLUMN acknowledged_by     uuid REFERENCES users(id),
  ADD COLUMN resolved_at         timestamptz,
  ADD COLUMN resolved_by         uuid REFERENCES users(id),
  ADD COLUMN resolution_note     text,
  ADD COLUMN award_event_id      uuid REFERENCES performance_events(id);

-- What the guard sent never changes; acknowledging, closing and the points award are each filled in once.
DROP TRIGGER bolos_immutable ON bolos;
CREATE FUNCTION bolos_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  open_cols text[] := ARRAY['acknowledged_at','acknowledged_by','resolved_at','resolved_by','resolution_note','award_event_id'];
BEGIN
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - open_cols) = (to_jsonb(OLD) - open_cols)
     AND (OLD.acknowledged_at IS NULL OR (NEW.acknowledged_at = OLD.acknowledged_at AND NEW.acknowledged_by IS NOT DISTINCT FROM OLD.acknowledged_by))
     AND (OLD.resolved_at IS NULL OR (NEW.resolved_at = OLD.resolved_at AND NEW.resolved_by IS NOT DISTINCT FROM OLD.resolved_by
                                       AND NEW.resolution_note IS NOT DISTINCT FROM OLD.resolution_note))
     AND (OLD.award_event_id IS NULL OR NEW.award_event_id = OLD.award_event_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'bolos records are immutable';
END $$;
CREATE TRIGGER bolos_immutable BEFORE UPDATE OR DELETE ON bolos FOR EACH ROW EXECUTE FUNCTION bolos_immutable();
CREATE INDEX bolos_open ON bolos (company_id, reported_at DESC) WHERE resolved_at IS NULL;
GRANT UPDATE ON bolos TO onpar_app;

-- BOLO photos, videos and voice notes follow the company's retention switch (POPIA P-3, P-5).
-- 90 days proposed; the owner or POPIA specialist sets the real period.
ALTER TABLE retention_settings ADD COLUMN bolo_media_days integer NOT NULL DEFAULT 90 CHECK (bolo_media_days BETWEEN 7 AND 3650);
ALTER TABLE retention_log DROP CONSTRAINT retention_log_kind_check;
ALTER TABLE retention_log ADD CONSTRAINT retention_log_kind_check CHECK (kind IN ('selfie','patrol_photo','bolo_media'));

-- Points awarded for a useful BOLO point back at it.
ALTER TABLE performance_events DROP CONSTRAINT performance_events_source_type_check;
ALTER TABLE performance_events ADD CONSTRAINT performance_events_source_type_check
  CHECK (source_type IN ('attendance','task','manual','reversal','report','training','patrol','bolo'));
