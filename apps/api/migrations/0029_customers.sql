-- Phase 3 of the plan of 6 Oct 2026: the customer foundation (decision D-39).
-- A customer is someone at a site who is not staff: the client who hires the security
-- company, or a tenant (a resident or business) inside the site. Both use the same customer
-- app and sign in with email and password. Only the administrator creates them. They are
-- kept apart from staff sign-ins, so a customer can never be given staff access by mistake.

-- A unit inside a site: a house, flat, office or shop.
CREATE TABLE site_units (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  site_id     uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  -- The number or address on site, as people there say it: "14", "Block B flat 3", "Shop 7".
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX site_units_name ON site_units (site_id, lower(name));

CREATE TABLE customers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL REFERENCES companies(id),
  site_id                uuid NOT NULL REFERENCES sites(id),
  -- A tenant belongs to a unit. The client (the estate office, the body corporate) need not.
  unit_id                uuid REFERENCES site_units(id),
  kind                   text NOT NULL CHECK (kind IN ('client','tenant')),
  full_name              text NOT NULL,
  email                  text NOT NULL,
  -- The number the gate phones when the customer does not answer an alert.
  phone                  text NOT NULL DEFAULT '',
  second_contact_name    text NOT NULL DEFAULT '',
  second_contact_phone   text NOT NULL DEFAULT '',
  password_hash          text NOT NULL,
  must_change_password   boolean NOT NULL DEFAULT true,
  password_changed_at    timestamptz,
  active                 boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid REFERENCES users(id),
  CHECK (kind <> 'tenant' OR unit_id IS NOT NULL)
);
-- An email address signs in to one account only, across all companies (and, checked by the
-- application, never both a staff sign-in and a customer sign-in).
CREATE UNIQUE INDEX customers_email_unique ON customers (lower(email));
CREATE INDEX customers_site ON customers (site_id);
CREATE INDEX customers_unit ON customers (unit_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['site_units','customers']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON site_units, customers TO onpar_app;

-- Sign-in happens before the company is known, as for staff.
CREATE FUNCTION auth_customer_by_email(p_email text)
RETURNS TABLE (id uuid, company_id uuid, password_hash text, active boolean, full_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, company_id, password_hash, active, full_name FROM customers WHERE lower(email) = lower(p_email)
$$;
-- Whether an email address already signs in to anything, in any company (for the "already in use" check).
CREATE FUNCTION auth_email_taken(p_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM users WHERE lower(email) = lower(p_email))
      OR EXISTS (SELECT 1 FROM customers WHERE lower(email) = lower(p_email))
$$;
REVOKE ALL ON FUNCTION auth_customer_by_email(text), auth_email_taken(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_customer_by_email(text), auth_email_taken(text) TO onpar_app;

-- The audit log can name a customer as the person who did something.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_type_check CHECK (actor_type IN ('user','employee','device','system','customer'));

-- Alerts can go to a customer as well as to staff: each alert, device and setting belongs to
-- exactly one of the two.
ALTER TABLE push_subscriptions ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE push_subscriptions ADD COLUMN customer_id uuid REFERENCES customers(id) ON DELETE CASCADE;
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_owner CHECK ((user_id IS NULL) <> (customer_id IS NULL));
CREATE INDEX push_subscriptions_customer ON push_subscriptions (customer_id);

ALTER TABLE notifications ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE notifications ADD COLUMN customer_id uuid REFERENCES customers(id) ON DELETE CASCADE;
ALTER TABLE notifications ADD CONSTRAINT notifications_owner CHECK ((user_id IS NULL) <> (customer_id IS NULL));
CREATE INDEX notifications_customer ON notifications (customer_id, created_at DESC);
