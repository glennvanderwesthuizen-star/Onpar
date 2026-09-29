-- Milestone 21: shift patterns and rostering (brief sections 31 and 36 to 43; decisions D-19, D-20, D-25).
-- A guard's shifts are computed from his allocation, never stored per day.

-- Guards needed per weekday (Mon..Sun) and on public holidays. NULL means guards_required every day.
ALTER TABLE site_shifts ADD COLUMN guards_by_day smallint[]
  CHECK (guards_by_day IS NULL OR array_length(guards_by_day, 1) = 8);

-- A single date with a different number of guards (for example an event night).
CREATE TABLE site_requirement_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  shift_id    uuid NOT NULL REFERENCES site_shifts(id) ON DELETE CASCADE,
  date        date NOT NULL,
  guards      smallint NOT NULL CHECK (guards BETWEEN 0 AND 999),
  note        text NOT NULL DEFAULT '',
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shift_id, date)
);

-- Extra public holidays a company adds (for example an election day). The statutory ones are computed.
CREATE TABLE company_holidays (
  company_id  uuid NOT NULL REFERENCES companies(id),
  date        date NOT NULL,
  name        text NOT NULL,
  PRIMARY KEY (company_id, date)
);

-- Reusable patterns, with a two-digit number per company.
CREATE TABLE shift_patterns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  number      smallint NOT NULL CHECK (number BETWEEN 1 AND 99),
  name        text NOT NULL,
  sequence    text[] NOT NULL CHECK (array_length(sequence, 1) BETWEEN 1 AND 56 AND sequence <@ ARRAY['D','N','O']),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number)
);
CREATE UNIQUE INDEX shift_patterns_name ON shift_patterns (company_id, lower(name));

-- Site + pattern + person + start date + position. Only one may be active per person
-- (section 38); the server's allocate operation ends the old one first. Ended ones stay
-- as history so past dates still compute correctly.
CREATE TABLE roster_allocations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  employee_id  uuid NOT NULL REFERENCES employees(id),
  site_id      uuid NOT NULL REFERENCES sites(id),
  pattern_id   uuid NOT NULL REFERENCES shift_patterns(id),
  start_date   date NOT NULL,
  position     smallint NOT NULL CHECK (position >= 1),
  end_date     date,                -- first date it no longer applies; NULL while active
  exception_reason text,            -- a grade or firearm mismatch accepted by the manager (section 39)
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  ended_by     uuid REFERENCES users(id),
  ended_at     timestamptz
);
CREATE INDEX roster_allocations_employee ON roster_allocations (employee_id);
CREATE INDEX roster_allocations_site ON roster_allocations (site_id) WHERE end_date IS NULL;

-- One guard's day changed by hand (D-25): once for a date, or weekly on a weekday.
-- shift_id NULL means a day off.
CREATE TABLE roster_changes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  employee_id  uuid NOT NULL REFERENCES employees(id),
  date         date,
  weekday      smallint CHECK (weekday BETWEEN 0 AND 6),
  from_date    date,
  until_date   date,
  shift_id     uuid REFERENCES site_shifts(id) ON DELETE CASCADE,
  note         text NOT NULL DEFAULT '',
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((date IS NOT NULL AND weekday IS NULL AND from_date IS NULL AND until_date IS NULL)
      OR (date IS NULL AND weekday IS NOT NULL AND from_date IS NOT NULL AND (until_date IS NULL OR until_date >= from_date)))
);
CREATE UNIQUE INDEX roster_changes_once ON roster_changes (employee_id, date) WHERE date IS NOT NULL;
CREATE INDEX roster_changes_employee ON roster_changes (employee_id);

-- How a Duty On related to the roster.
ALTER TABLE attendance ADD COLUMN roster_status text NOT NULL DEFAULT 'no_roster'
  CHECK (roster_status IN ('rostered','not_rostered_here','no_roster'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['site_requirement_changes','company_holidays','shift_patterns','roster_allocations','roster_changes']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON site_requirement_changes, company_holidays, roster_changes TO onpar_app;
GRANT SELECT, INSERT, UPDATE ON shift_patterns, roster_allocations TO onpar_app;
