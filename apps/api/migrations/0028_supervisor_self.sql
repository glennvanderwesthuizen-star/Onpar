-- A supervisor is also an employee (decision D-42, 6 Oct 2026). A sign-in can be joined to
-- the person's own officer record. He then logs his own Duty On and Duty From from the
-- supervisor app on his own phone (no location is taken), and sees his own shifts, score,
-- training and uniform there, under the same rules as on a post phone.
ALTER TABLE users ADD COLUMN employee_id uuid REFERENCES employees(id);
-- One officer record belongs to at most one sign-in.
CREATE UNIQUE INDEX users_employee_unique ON users (employee_id) WHERE employee_id IS NOT NULL;

-- A shift logged from the person's own phone rather than a post phone. Such a shift is outside
-- the wait-for-relief rule: he does not wait for a relief, and he neither relieves a guard nor
-- needs relieving, so he is left out when a guard's relief is worked out.
ALTER TABLE attendance ADD COLUMN own_phone boolean NOT NULL DEFAULT false;
