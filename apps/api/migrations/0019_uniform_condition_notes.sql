-- Uniform condition notes (owner's decision D-33, docs/NEXT_ROUND.md item 10).
-- An HR record: a supervisor notes that a guard's uniform is torn, dirty or badly kept,
-- with an optional photo. Kept apart from operational data, with its own permissions and
-- every view audited; never shown on the post phone; never triggers anything by itself.
CREATE TABLE hr_uniform_notes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id),
  employee_id         uuid NOT NULL REFERENCES employees(id),
  noted_by            uuid NOT NULL REFERENCES users(id),
  condition           text NOT NULL CHECK (condition IN ('torn','dirty','badly_kept','missing_items','other')),
  note                text NOT NULL,
  photo_key           text,
  photo_content_type  text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hr_uniform_notes_employee ON hr_uniform_notes (employee_id, created_at DESC);
CREATE TRIGGER hr_uniform_notes_immutable BEFORE UPDATE OR DELETE ON hr_uniform_notes FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE hr_uniform_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON hr_uniform_notes USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT ON hr_uniform_notes TO onpar_app;
