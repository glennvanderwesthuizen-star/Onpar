-- Repeated warnings and the disciplinary inquiry (owner, 9 Oct 2026; D-53). At the third
-- warning management is alerted and chooses: an end of line memorandum, or a disciplinary
-- inquiry with its documents, the inquiry form and the published outcome. Nothing is automatic.

ALTER TABLE hr_settings ADD COLUMN warning_threshold integer NOT NULL DEFAULT 3 CHECK (warning_threshold BETWEEN 2 AND 10);
ALTER TABLE hr_settings ADD COLUMN warning_months integer NOT NULL DEFAULT 12 CHECK (warning_months BETWEEN 1 AND 60);
ALTER TABLE hr_settings ADD COLUMN hearing_min_days integer NOT NULL DEFAULT 3 CHECK (hearing_min_days BETWEEN 1 AND 30);

-- Documents sent with a notice (the rights documents with a notice to appear). Part of the notice: never changed.
ALTER TABLE notices ADD COLUMN documents jsonb NOT NULL DEFAULT '[]';

CREATE TABLE disciplinary_cases (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id),
  employee_id        uuid NOT NULL REFERENCES employees(id),
  charge             text NOT NULL,
  -- The warnings that led to it (notice ids).
  warning_ids        jsonb NOT NULL DEFAULT '[]',
  hearing_date       date NOT NULL,
  hearing_time       time NOT NULL,
  venue              text NOT NULL,
  chairperson        text NOT NULL DEFAULT '',
  initiator          text NOT NULL DEFAULT '',
  witnesses          jsonb NOT NULL DEFAULT '[]',
  -- 'notice_sent': waiting for the inquiry; 'published': the decision went to the employee; 'withdrawn'.
  status             text NOT NULL DEFAULT 'notice_sent' CHECK (status IN ('notice_sent','published','withdrawn')),
  notice_id          uuid REFERENCES notices(id),
  -- The inquiry form, filled in after the inquiry; fixed once the decision is published.
  hearing            jsonb NOT NULL DEFAULT '{}',
  outcome_notice_id  uuid REFERENCES notices(id),
  opened_by          uuid NOT NULL REFERENCES users(id),
  opened_at          timestamptz NOT NULL DEFAULT now(),
  closed_at          timestamptz
);
CREATE INDEX disciplinary_cases_employee ON disciplinary_cases (employee_id, opened_at DESC);
-- Once published or withdrawn, a case can never change.
CREATE FUNCTION disciplinary_case_closed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'notice_sent' THEN
    RAISE EXCEPTION 'A closed disciplinary case cannot be changed or removed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER disciplinary_cases_closed BEFORE UPDATE OR DELETE ON disciplinary_cases FOR EACH ROW EXECUTE FUNCTION disciplinary_case_closed();

-- Everything that happens to a case, in order. Append-only.
CREATE TABLE disciplinary_events (
  id           bigserial PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies(id),
  case_id      uuid NOT NULL REFERENCES disciplinary_cases(id),
  kind         text NOT NULL CHECK (kind IN ('opened','notice_sent','form_saved','file_added','published','withdrawn')),
  at           timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid REFERENCES users(id),
  actor_label  text NOT NULL DEFAULT '',
  note         text NOT NULL DEFAULT '',
  snapshot     jsonb
);
CREATE INDEX disciplinary_events_case ON disciplinary_events (case_id, at);
CREATE TRIGGER disciplinary_events_immutable BEFORE UPDATE OR DELETE ON disciplinary_events FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- The signed inquiry form, statements and other evidence, uploaded. Append-only.
CREATE TABLE disciplinary_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  case_id       uuid NOT NULL REFERENCES disciplinary_cases(id),
  title         text NOT NULL,
  storage_key   text NOT NULL,
  content_type  text NOT NULL,
  uploaded_by   uuid NOT NULL REFERENCES users(id),
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER disciplinary_files_immutable BEFORE UPDATE OR DELETE ON disciplinary_files FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['disciplinary_cases','disciplinary_events','disciplinary_files']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON disciplinary_cases TO onpar_app;
GRANT SELECT, INSERT ON disciplinary_events, disciplinary_files TO onpar_app;
GRANT USAGE ON SEQUENCE disciplinary_events_id_seq TO onpar_app;
