-- Milestone 1: foundation.
-- Run as the owner role (onpar_owner). The application connects as onpar_app,
-- which owns nothing, so row-level security always applies to it.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The tenant the current transaction acts for. Empty or unset means no rows.
CREATE FUNCTION app_company_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.company_id', true), '')::uuid
$$;

-- Companies ----------------------------------------------------------------

CREATE TABLE companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Management users (web dashboard) -----------------------------------------

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  email          text NOT NULL,
  full_name      text NOT NULL,
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('system_admin','company_manager','site_manager',
                   'site_supervisor','client_manager','hr_admin','payroll_clerk')),
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- Email identifies a login across all companies.
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));
CREATE INDEX users_company ON users (company_id);

-- Sites --------------------------------------------------------------------

CREATE TABLE sites (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id),
  name               text NOT NULL,
  address            text NOT NULL,
  client             text NOT NULL,
  minimum_grade      char(1) NOT NULL CHECK (minimum_grade IN ('A','B','C','D','E')),
  armed              boolean NOT NULL,
  payroll_start_day  smallint NOT NULL DEFAULT 26 CHECK (payroll_start_day BETWEEN 1 AND 28),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sites_name_unique ON sites (company_id, lower(name));

CREATE TABLE site_shifts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  site_id          uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name             text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('day','night')),
  start_time       time NOT NULL,
  end_time         time NOT NULL,
  guards_required  integer NOT NULL CHECK (guards_required >= 1),
  equipment        jsonb NOT NULL DEFAULT '{}',
  sort_order       integer NOT NULL DEFAULT 0
);
CREATE INDEX site_shifts_site ON site_shifts (site_id);

CREATE TABLE site_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  site_id     uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('supervisor','site_manager','control_room')),
  name        text NOT NULL DEFAULT '',
  phone       text NOT NULL,
  UNIQUE (site_id, kind)
);

-- Which sites a site-scoped user (supervisor, site manager, client) may see.
CREATE TABLE user_sites (
  company_id  uuid NOT NULL REFERENCES companies(id),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id     uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, site_id)
);

-- Employees (officers) -----------------------------------------------------

CREATE TABLE employees (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id),
  employee_number      text NOT NULL,
  full_name            text NOT NULL,
  -- The ID number is encrypted by the application; only the last four digits
  -- are stored in the clear for display, and an HMAC for duplicate checks.
  id_number_enc        text NOT NULL,
  id_number_hmac       text NOT NULL,
  id_number_last4      char(4) NOT NULL,
  date_of_birth        date NOT NULL,
  cell_number          text NOT NULL,
  next_of_kin_name     text NOT NULL,
  next_of_kin_number   text NOT NULL,
  psira_number         text NOT NULL,
  psira_grade          char(1) NOT NULL CHECK (psira_grade IN ('A','B','C','D','E')),
  psira_expiry         date NOT NULL,
  home_site_id         uuid NOT NULL REFERENCES sites(id),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  pin_hash             text,
  pin_failed_attempts  integer NOT NULL DEFAULT 0,
  pin_locked_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES users(id),
  UNIQUE (company_id, employee_number),
  UNIQUE (company_id, id_number_hmac)
);
CREATE INDEX employees_site ON employees (home_site_id);

CREATE TABLE employee_photos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  employee_id   uuid NOT NULL REFERENCES employees(id),
  kind          text NOT NULL CHECK (kind IN ('face','full_body','id_document','psira_card')),
  storage_key   text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    integer NOT NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  uploaded_by   uuid REFERENCES users(id),
  UNIQUE (employee_id, kind)
);

CREATE TABLE qualifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  employee_id      uuid NOT NULL REFERENCES employees(id),
  type             text NOT NULL,
  name             text NOT NULL,
  completion_date  date,
  expiry_date      date,
  certificate_key  text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX qualifications_employee ON qualifications (employee_id);

CREATE TABLE issued_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  employee_id   uuid NOT NULL REFERENCES employees(id),
  item          text NOT NULL,
  size          text,
  asset_number  text,
  issue_date    date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX issued_items_employee ON issued_items (employee_id);

-- Devices --------------------------------------------------------------------

CREATE TABLE devices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  label           text NOT NULL,
  serial_or_imei  text NOT NULL,
  site_id         uuid REFERENCES sites(id),
  post_name       text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'registered'
                    CHECK (status IN ('registered','active','locked','disabled','retired')),
  kiosk_status    text NOT NULL DEFAULT 'unknown',
  app_version     text,
  last_seen_at    timestamptz,
  battery_pct     smallint,
  token_hash      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX devices_token ON devices (token_hash);
CREATE UNIQUE INDEX devices_serial ON devices (company_id, serial_or_imei);

-- Audit log: append-only -----------------------------------------------------

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies(id),
  at           timestamptz NOT NULL DEFAULT now(),
  actor_type   text NOT NULL CHECK (actor_type IN ('user','employee','device','system')),
  actor_id     uuid,
  actor_label  text NOT NULL DEFAULT '',
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    uuid,
  before       jsonb,
  after        jsonb,
  reason       text
);
CREATE INDEX audit_log_company_at ON audit_log (company_id, at DESC);
CREATE INDEX audit_log_entity ON audit_log (entity_type, entity_id);

CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- Row-level security -----------------------------------------------------------
-- Every tenant table only shows rows for app_company_id(). Tables are owned by
-- onpar_owner, which is exempt; onpar_app is not.

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON companies USING (id = app_company_id());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','sites','site_shifts','site_contacts','user_sites','employees',
                           'employee_photos','qualifications','issued_items','devices','audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id())
                    WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

-- Lookups that must work before the tenant is known. They run as the owner
-- (SECURITY DEFINER) and return only what login needs.

CREATE FUNCTION auth_user_by_email(p_email text)
RETURNS TABLE (id uuid, company_id uuid, password_hash text, role text, active boolean, full_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, company_id, password_hash, role, active, full_name FROM users WHERE lower(email) = lower(p_email)
$$;

CREATE FUNCTION auth_device_by_token_hash(p_hash text)
RETURNS TABLE (id uuid, company_id uuid, status text, site_id uuid, label text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, company_id, status, site_id, label FROM devices WHERE token_hash = p_hash
$$;

-- Grants to the application role ---------------------------------------------

GRANT USAGE ON SCHEMA public TO onpar_app;
GRANT SELECT ON companies TO onpar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, sites, site_shifts, site_contacts, user_sites,
  employees, employee_photos, qualifications, issued_items, devices TO onpar_app;
GRANT SELECT, INSERT ON audit_log TO onpar_app;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO onpar_app;
REVOKE ALL ON FUNCTION auth_user_by_email(text), auth_device_by_token_hash(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_user_by_email(text), auth_device_by_token_hash(text), app_company_id() TO onpar_app;
