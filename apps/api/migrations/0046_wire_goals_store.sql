-- The Wire, step 3 (owner, 8 Oct 2026): the owner's goals and store table, a guard's goal, and
-- hand-ins. The store stays closed until the owner opens it (after the accountant's answer on tax).

CREATE TABLE wire_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id),
  name                text NOT NULL,
  category            text NOT NULL CHECK (category IN ('airtime','data','voucher','kit','training','milestone','other')),
  barbs               integer NOT NULL CHECK (barbs >= 0),
  cost_rand           numeric(10,2),                     -- the company's cost; never sent to a guard's phone
  months_service      integer NOT NULL DEFAULT 0,
  wire_at_least       integer NOT NULL DEFAULT 0,
  needs_grade         char(1) CHECK (needs_grade IN ('A','B','C','D','E')),
  months_at_standard  integer NOT NULL DEFAULT 0,
  in_store            boolean NOT NULL DEFAULT true,
  active              boolean NOT NULL DEFAULT true,
  sort                integer NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX wire_items_name ON wire_items (company_id, lower(name));

-- A guard's goal: a row of the table, or his own words. One at a time.
CREATE TABLE wire_goals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  employee_id  uuid NOT NULL REFERENCES employees(id),
  item_id      uuid REFERENCES wire_items(id),
  own_words    text,
  set_at       timestamptz NOT NULL DEFAULT now(),
  reached_at   timestamptz,
  ended_at     timestamptz,
  CHECK ((item_id IS NULL) <> (own_words IS NULL))
);
CREATE UNIQUE INDEX wire_goals_one ON wire_goals (employee_id) WHERE ended_at IS NULL;

-- Barbs handed in for something in the store, and whether it has been supplied.
CREATE TABLE wire_handins (
  id             uuid PRIMARY KEY,                         -- the phone's event id
  company_id     uuid NOT NULL REFERENCES companies(id),
  employee_id    uuid NOT NULL REFERENCES employees(id),
  site_id        uuid REFERENCES sites(id),
  item_id        uuid NOT NULL REFERENCES wire_items(id),
  item_name      text NOT NULL,
  category       text NOT NULL,
  barbs          integer NOT NULL CHECK (barbs > 0),
  cost_rand      numeric(10,2),
  status         text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','supplied','cancelled')),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  done_by        uuid REFERENCES users(id),
  done_at        timestamptz,
  cancel_reason  text
);
CREATE INDEX wire_handins_open ON wire_handins (company_id, status, requested_at);

-- A cancelled hand-in gives the barbs back to "available"; the Wire total never changes.
ALTER TABLE wire_entries DROP CONSTRAINT wire_entries_kind_check;
ALTER TABLE wire_entries ADD CONSTRAINT wire_entries_kind_check CHECK (kind IN ('earned','handed_in','returned'));

ALTER TABLE wire_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE wire_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE wire_handins ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON wire_items USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
CREATE POLICY tenant ON wire_goals USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
CREATE POLICY tenant ON wire_handins USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON wire_items, wire_goals, wire_handins TO onpar_app;
