-- Relief at shift change (owner's decision D-33): a guard may log Duty From only once
-- his relief has arrived, first in first out, or 30 minutes after the shift if nobody came.

ALTER TABLE attendance
  -- How the guard left: relieved by an arriving guard, no relief within the waiting time
  -- (post uncovered), released by a supervisor, no rule (no scheduled end), or not checked
  -- (Duty From sent late from a phone without signal).
  ADD COLUMN relief_status text CHECK (relief_status IN ('relieved','no_relief','released','no_rule','not_checked')),
  -- The arriving guard's attendance he left on.
  ADD COLUMN relieved_by_attendance_id uuid REFERENCES attendance(id),
  -- When he gave his turn to a partner ("let my partner go first").
  ADD COLUMN turn_given_at timestamptz;

CREATE INDEX attendance_site_end ON attendance (site_id, scheduled_end);
CREATE INDEX attendance_site_start ON attendance (site_id, scheduled_start);
