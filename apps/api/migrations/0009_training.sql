-- Milestone 8: qualifications and training (brief section 6.9).
-- A renewal is a new record; the old one stays as history. Corrections are audited.
ALTER TABLE qualifications ADD COLUMN recorded_by uuid REFERENCES users(id);
ALTER TABLE qualifications ADD COLUMN certificate_content_type text;
ALTER TABLE qualifications ADD COLUMN updated_at timestamptz;
GRANT SELECT, INSERT, UPDATE ON qualifications TO onpar_app;
