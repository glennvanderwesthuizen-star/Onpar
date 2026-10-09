-- The Occurrence Book (owner, 9 Oct 2026, D-51): guards also write entries, on the post phone.
-- Sent from the phone (also with no signal), so each carries the phone's event id.
ALTER TABLE ob_entries ALTER COLUMN written_by DROP NOT NULL;
ALTER TABLE ob_entries ADD COLUMN written_by_employee uuid REFERENCES employees(id);
ALTER TABLE ob_entries ADD COLUMN device_id uuid REFERENCES devices(id);
ALTER TABLE ob_entries ADD COLUMN event_id uuid;
ALTER TABLE ob_entries ADD COLUMN late_synced boolean NOT NULL DEFAULT false;
ALTER TABLE ob_entries ADD CONSTRAINT ob_entries_writer CHECK ((written_by IS NULL) <> (written_by_employee IS NULL));
CREATE UNIQUE INDEX ob_entries_event ON ob_entries (company_id, event_id) WHERE event_id IS NOT NULL;
