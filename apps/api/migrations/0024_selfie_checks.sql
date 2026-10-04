-- Selfie checks (owner, 4 Oct 2026; D-36, face recognition stage 1). A supervisor or manager
-- looks at a Duty On or Duty From selfie next to the guard's enrolment photo and records
-- whether it is him. People do the checking. A "not him" result is a flag for a manager to
-- look into; it never triggers discipline or anything else by itself. Append-only: a second
-- look adds a new check, the latest one counts.
CREATE TABLE selfie_checks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  declaration_id  uuid NOT NULL REFERENCES declarations(id),
  attendance_id   uuid NOT NULL REFERENCES attendance(id),
  employee_id     uuid NOT NULL REFERENCES employees(id),
  result          text NOT NULL CHECK (result IN ('match','not_match','unclear')),
  note            text NOT NULL DEFAULT '',
  source          text NOT NULL CHECK (source IN ('review','spot_check')),
  checked_by      uuid NOT NULL REFERENCES users(id),
  checked_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX selfie_checks_declaration ON selfie_checks (declaration_id, checked_at DESC);
CREATE TRIGGER selfie_checks_immutable BEFORE UPDATE OR DELETE ON selfie_checks FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE selfie_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON selfie_checks USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT ON selfie_checks TO onpar_app;
