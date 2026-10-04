-- Automatic face matching (owner, 4 Oct 2026; D-36 stage 2). Runs on On Par's own server with
-- open-source software; no photo or face data leaves the server. Off until a company switches it
-- on (POPIA: biometric data is special personal information; reviewed at the end under P-5).
-- Only the result is kept (a distance and a verdict), never a face template. A result is a flag
-- for a person to look at; it never blocks a guard or triggers anything by itself.
ALTER TABLE retention_settings ADD COLUMN face_matching boolean NOT NULL DEFAULT false;

CREATE TABLE face_matches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  employee_id     uuid NOT NULL REFERENCES employees(id),
  kind            text NOT NULL CHECK (kind IN ('enrolment_id_document','enrolment_psira_card','duty_selfie')),
  declaration_id  uuid REFERENCES declarations(id),
  distance        numeric(5,4),
  verdict         text NOT NULL CHECK (verdict IN ('match','uncertain','no_match','no_face')),
  faces_found     jsonb NOT NULL DEFAULT '{}',
  model           text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'duty_selfie') = (declaration_id IS NOT NULL))
);
CREATE INDEX face_matches_employee ON face_matches (employee_id, created_at DESC);
CREATE INDEX face_matches_declaration ON face_matches (declaration_id) WHERE declaration_id IS NOT NULL;
CREATE TRIGGER face_matches_immutable BEFORE UPDATE OR DELETE ON face_matches FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE face_matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON face_matches USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT ON face_matches TO onpar_app;

-- The blink check on the phone before the selfie (D-36): 'passed', 'not_passed' (the guard took
-- the selfie anyway, for a person to look at), or empty (an older phone). Set when the
-- declaration is made; declarations stay immutable.
ALTER TABLE declarations ADD COLUMN liveness text CHECK (liveness IN ('passed','not_passed'));
