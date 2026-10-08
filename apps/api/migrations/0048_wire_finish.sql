-- Finishing The Wire (owner, 8 Oct 2026): task opened ("seen") for fast response, mentoring,
-- guards who have left, and reminders for things waiting on the owner.

ALTER TABLE task_occurrences ADD COLUMN seen_at timestamptz, ADD COLUMN seen_by uuid REFERENCES employees(id);

CREATE TABLE wire_mentors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  mentor_id   uuid NOT NULL REFERENCES employees(id),
  mentee_id   uuid NOT NULL REFERENCES employees(id),
  start_date  date NOT NULL,
  end_date    date,
  set_by      uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (mentor_id <> mentee_id)
);
CREATE UNIQUE INDEX wire_mentors_one ON wire_mentors (mentee_id) WHERE end_date IS NULL;
ALTER TABLE wire_mentors ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON wire_mentors USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON wire_mentors TO onpar_app;

-- The day The Wire first saw him as having left; his available barbs lapse some days later.
ALTER TABLE wire_profiles ADD COLUMN left_on date;

ALTER TABLE wire_notes ADD COLUMN reminded_at timestamptz;
ALTER TABLE wire_awards ADD COLUMN reminded_at timestamptz;
ALTER TABLE wire_handins ADD COLUMN reminded_at timestamptz;
