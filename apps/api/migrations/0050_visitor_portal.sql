-- Visitor management, step 5 of the owner's list (8 Oct 2026): the emergency roll-call, and
-- visitor records under the retention policy (visitor specification: 12 months by default,
-- to be signed off by whoever handles POPIA; removal stays off until a company switches it on).

-- An emergency roll-call at a site: everyone on site, ticked off at the assembly point.
CREATE TABLE roll_calls (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  site_id     uuid NOT NULL REFERENCES sites(id),
  reason      text NOT NULL DEFAULT '',
  started_by  uuid NOT NULL REFERENCES users(id),
  started_at  timestamptz NOT NULL DEFAULT now(),
  closed_by   uuid REFERENCES users(id),
  closed_at   timestamptz,
  close_note  text NOT NULL DEFAULT ''
);
-- One open roll-call per site at a time.
CREATE UNIQUE INDEX roll_calls_open ON roll_calls (site_id) WHERE closed_at IS NULL;
CREATE INDEX roll_calls_site ON roll_calls (site_id, started_at DESC);

-- Each tick: who was marked safe or missing, or the mark taken back ('clear'). The latest mark counts. Append-only.
CREATE TABLE roll_call_marks (
  id            bigserial PRIMARY KEY,
  company_id    uuid NOT NULL REFERENCES companies(id),
  roll_call_id  uuid NOT NULL REFERENCES roll_calls(id),
  -- 'visit:<visit id>' or 'guard:<employee id>'
  person_key    text NOT NULL,
  status        text NOT NULL CHECK (status IN ('safe','missing','clear')),
  marked_by     uuid NOT NULL REFERENCES users(id),
  marked_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX roll_call_marks_call ON roll_call_marks (roll_call_id, person_key, marked_at DESC);
CREATE TRIGGER roll_call_marks_immutable BEFORE UPDATE OR DELETE ON roll_call_marks FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['roll_calls','roll_call_marks']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON roll_calls TO onpar_app;
GRANT SELECT, INSERT ON roll_call_marks TO onpar_app;
GRANT USAGE ON SEQUENCE roll_call_marks_id_seq TO onpar_app;

-- Visitor records under retention: photos removed, and a visitor's name and numbers anonymised
-- once they have not been seen for the period. The visit itself stays, for the counts.
ALTER TABLE retention_settings ADD COLUMN visitor_months integer NOT NULL DEFAULT 12 CHECK (visitor_months BETWEEN 1 AND 120);
ALTER TABLE retention_log DROP CONSTRAINT retention_log_kind_check;
ALTER TABLE retention_log ADD CONSTRAINT retention_log_kind_check
  CHECK (kind IN ('selfie','patrol_photo','bolo_media','visit_photo','visit_document','visit_exception_photo','visitor_person','visitor_vehicle','visitor_pass'));
