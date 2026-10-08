-- The Wire: the guard reward programme (owner's rule book and build specification, 8 Oct 2026).
-- Reward only: barbs are earned and never taken away. Separate from performance scoring.

-- The company's values for The Wire. No row: the rule book's defaults. `started_on` is the day
-- The Wire began for the company; nothing before it earns barbs.
CREATE TABLE wire_settings (
  company_id  uuid PRIMARY KEY REFERENCES companies(id),
  config      jsonb NOT NULL DEFAULT '{}',
  started_on  date NOT NULL DEFAULT (now() AT TIME ZONE 'Africa/Johannesburg')::date,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- A guard's Wire profile: when he joined (for long service and launch credit), his recruitment
-- score (for entry barbs) and whether his name may be shown on the board.
CREATE TABLE wire_profiles (
  employee_id        uuid PRIMARY KEY REFERENCES employees(id),
  company_id         uuid NOT NULL REFERENCES companies(id),
  joined_on          date NOT NULL,
  recruitment_score  smallint CHECK (recruitment_score BETWEEN 0 AND 100),
  show_name          boolean NOT NULL DEFAULT false,
  updated_by         uuid REFERENCES users(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- The barb ledger: the source of truth. Every barb earned (and later, handed in) is one row,
-- never changed or removed. Each rule pays once per thing (`source_key`), so a re-run adds
-- only what is newly due.
CREATE TABLE wire_entries (
  id           bigserial PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies(id),
  employee_id  uuid NOT NULL REFERENCES employees(id),
  site_id      uuid REFERENCES sites(id),
  entry_date   date NOT NULL,
  kind         text NOT NULL DEFAULT 'earned' CHECK (kind IN ('earned','handed_in')),
  rule         text NOT NULL,
  barbs        integer NOT NULL CHECK (barbs > 0),
  source_key   text NOT NULL,
  note         text NOT NULL DEFAULT '',
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, rule, source_key)
);
CREATE INDEX wire_entries_guard ON wire_entries (employee_id, entry_date);
CREATE INDEX wire_entries_company ON wire_entries (company_id, entry_date);

-- A guard's month, locked at month end: his score, his own average, the award and his run.
CREATE TABLE wire_months (
  employee_id   uuid NOT NULL REFERENCES employees(id),
  month         char(7) NOT NULL,
  company_id    uuid NOT NULL REFERENCES companies(id),
  site_id       uuid REFERENCES sites(id),
  attendance    numeric(5,1),
  job           numeric(5,1),
  overall       numeric(5,1),
  average       numeric(5,1),
  award         text CHECK (award IN ('standard','improvement')),
  streak        integer NOT NULL,
  grace_month   char(7),
  facts         jsonb NOT NULL,
  locked_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, month)
);

-- Which month-end runs have been done for a company.
CREATE TABLE wire_month_runs (
  company_id  uuid NOT NULL REFERENCES companies(id),
  month       char(7) NOT NULL,
  ran_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, month)
);

ALTER TABLE wire_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE wire_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE wire_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE wire_months ENABLE ROW LEVEL SECURITY;
ALTER TABLE wire_month_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON wire_settings USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
CREATE POLICY tenant ON wire_profiles USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
CREATE POLICY tenant ON wire_entries USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
CREATE POLICY tenant ON wire_months USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
CREATE POLICY tenant ON wire_month_runs USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON wire_settings, wire_profiles TO onpar_app;
GRANT SELECT, INSERT ON wire_entries, wire_months, wire_month_runs TO onpar_app;
GRANT USAGE ON SEQUENCE wire_entries_id_seq TO onpar_app;
CREATE TRIGGER wire_entries_immutable BEFORE UPDATE OR DELETE ON wire_entries FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER wire_months_immutable BEFORE UPDATE OR DELETE ON wire_months FOR EACH ROW EXECUTE FUNCTION forbid_change();
