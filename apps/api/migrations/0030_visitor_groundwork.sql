-- Visitor management (spec of 3 Oct 2026; plan approved by the owner 7 Oct 2026), step 1:
-- the groundwork. Gates, the checks each site can switch on or off, visitor categories with
-- their time limits, and the barred list. No visitor is recorded yet; that starts in step 2.

-- A gate of a site. A customer who announces a visitor names one (D-39).
CREATE TABLE site_gates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  site_id     uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX site_gates_name ON site_gates (site_id, lower(name));

-- A site's visitor settings. A site with no row uses the defaults in the rules package.
CREATE TABLE site_visitor_settings (
  site_id                       uuid PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  company_id                    uuid NOT NULL REFERENCES companies(id),
  -- The checks, as { name: on or off }. Names are fixed by the rules package.
  checks                        jsonb NOT NULL,
  no_response_seconds           integer NOT NULL CHECK (no_response_seconds BETWEEN 30 AND 600),
  second_contact                boolean NOT NULL,
  overstay_escalation_minutes   integer NOT NULL CHECK (overstay_escalation_minutes BETWEEN 5 AND 240),
  -- How long visit records and face photos are kept: a proposal for legal to confirm.
  retention_months              integer NOT NULL CHECK (retention_months BETWEEN 1 AND 120),
  updated_by                    uuid REFERENCES users(id),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

-- Visitor categories of a site. Each carries its own overstay limit: time on site, or a time of day.
CREATE TABLE visitor_categories (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  site_id        uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name           text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('once_off','regular','fixed_period')),
  contractor     boolean NOT NULL DEFAULT false,
  limit_minutes  integer CHECK (limit_minutes BETWEEN 15 AND 10080),
  limit_until    time,
  active         boolean NOT NULL DEFAULT true,
  sort           integer NOT NULL DEFAULT 100,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (limit_minutes IS NULL OR limit_until IS NULL)
);
CREATE UNIQUE INDEX visitor_categories_name ON visitor_categories (site_id, lower(name));

-- The barred list. An entry bars one ID number, cell number or number plate from the whole
-- site, or from one unit. Entries are never deleted: taking one off records who and why.
CREATE TABLE barred_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  site_id         uuid NOT NULL REFERENCES sites(id),
  -- Null: barred from the whole site. Otherwise: barred from visiting this unit.
  unit_id         uuid REFERENCES site_units(id),
  kind            text NOT NULL CHECK (kind IN ('id_number','cell','registration')),
  -- In its compared form (capitals and digits only).
  value           text NOT NULL,
  reason          text NOT NULL CHECK (length(btrim(reason)) > 0),
  added_by        uuid NOT NULL REFERENCES users(id),
  added_at        timestamptz NOT NULL DEFAULT now(),
  -- Entries are reviewed yearly (spec: POPIA).
  review_due      date NOT NULL DEFAULT (current_date + interval '1 year'),
  removed_by      uuid REFERENCES users(id),
  removed_at      timestamptz,
  removal_reason  text,
  CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE UNIQUE INDEX barred_entries_active ON barred_entries (site_id, coalesce(unit_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, value) WHERE removed_at IS NULL;
CREATE INDEX barred_entries_site ON barred_entries (site_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['site_gates','site_visitor_settings','visitor_categories','barred_entries']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON site_gates, site_visitor_settings, visitor_categories, barred_entries TO onpar_app;
