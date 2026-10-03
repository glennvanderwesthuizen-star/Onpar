-- Uniform: catalogue, site lists, the annual issue and the order flow (owner's decision D-33).
-- Equipment and site supplies stay in re-orders.

-- A new role for the store that packs uniform orders.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('system_admin','company_manager','site_manager',
  'site_supervisor','client_manager','hr_admin','payroll_clerk','stores_clerk'));

-- The company's uniform items, each type separately (Shirt: short sleeve; Shirt: golf ...).
CREATE TABLE uniform_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  name            text NOT NULL,                 -- e.g. Shirt
  variant         text NOT NULL DEFAULT '',      -- e.g. Short sleeve
  sizes           text[] NOT NULL DEFAULT '{}',  -- e.g. {S,M,L,XL}
  price_cents     integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  renewal_months  integer NOT NULL DEFAULT 12 CHECK (renewal_months BETWEEN 1 AND 60),
  active          boolean NOT NULL DEFAULT true,
  sort_order      integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX uniform_items_name ON uniform_items (company_id, lower(name), lower(variant));

-- What a guard at each site is entitled to.
CREATE TABLE site_uniform_list (
  company_id  uuid NOT NULL REFERENCES companies(id),
  site_id     uuid NOT NULL REFERENCES sites(id),
  item_id     uuid NOT NULL REFERENCES uniform_items(id),
  quantity    integer NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  PRIMARY KEY (site_id, item_id)
);

CREATE TABLE uniform_orders (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid NOT NULL REFERENCES companies(id),
  number                  integer NOT NULL,
  employee_id             uuid NOT NULL REFERENCES employees(id),
  site_id                 uuid NOT NULL REFERENCES sites(id),
  device_id               uuid REFERENCES devices(id),
  status                  text NOT NULL DEFAULT 'requested'
                            CHECK (status IN ('requested','approved','ready','with_supervisor','received','declined')),
  requested_at            timestamptz NOT NULL,
  late_synced             boolean NOT NULL DEFAULT false,
  event_id                uuid UNIQUE,
  -- Stores confirms the supervisor collected it (the supervisor marks it too).
  handed_over_at          timestamptz,
  handed_over_by          uuid REFERENCES users(id),
  -- The guard signs for it on the phone; guard's-account items with the amount he agrees to pay (L-08).
  received_at             timestamptz,
  guard_agreed_cents      integer,
  guard_agreed_statement  text,
  UNIQUE (company_id, number)
);
CREATE INDEX uniform_orders_status ON uniform_orders (company_id, status);
CREATE INDEX uniform_orders_employee ON uniform_orders (employee_id, requested_at DESC);

CREATE TABLE uniform_order_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id),
  order_id          uuid NOT NULL REFERENCES uniform_orders(id),
  item_id           uuid NOT NULL REFERENCES uniform_items(id),
  size              text NOT NULL DEFAULT '',
  quantity          integer NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  was_due           boolean NOT NULL,
  reason            text NOT NULL DEFAULT '',     -- why, when not yet due
  decision          text CHECK (decision IN ('company','guard','declined')),
  decision_note     text NOT NULL DEFAULT '',
  unit_price_cents  integer NOT NULL DEFAULT 0    -- the price when decided
);
CREATE INDEX uniform_order_lines_order ON uniform_order_lines (order_id);

-- Every step: who, what, when. Append-only.
CREATE TABLE uniform_order_history (
  id           bigserial PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies(id),
  order_id     uuid NOT NULL REFERENCES uniform_orders(id),
  at           timestamptz NOT NULL DEFAULT now(),
  actor_type   text NOT NULL CHECK (actor_type IN ('user','employee')),
  actor_id     uuid,
  actor_label  text NOT NULL,
  actor_role   text NOT NULL,
  status_after text NOT NULL,
  note         text NOT NULL DEFAULT ''
);
CREATE INDEX uniform_order_history_order ON uniform_order_history (order_id, at, id);
CREATE TRIGGER uniform_order_history_immutable BEFORE UPDATE OR DELETE ON uniform_order_history FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- What each guard has received, and when: from a signed-for order, or a starter issue recorded
-- by a manager. The renewal dates come from here. Append-only.
CREATE TABLE uniform_issues (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  employee_id    uuid NOT NULL REFERENCES employees(id),
  item_id        uuid NOT NULL REFERENCES uniform_items(id),
  size           text NOT NULL DEFAULT '',
  quantity       integer NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  issued_on      date NOT NULL,
  account        text NOT NULL CHECK (account IN ('company','guard')),
  order_line_id  uuid REFERENCES uniform_order_lines(id),
  note           text NOT NULL DEFAULT '',
  recorded_by    uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX uniform_issues_employee ON uniform_issues (employee_id, item_id, issued_on DESC);
CREATE TRIGGER uniform_issues_immutable BEFORE UPDATE OR DELETE ON uniform_issues FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['uniform_items','site_uniform_list','uniform_orders','uniform_order_lines','uniform_order_history','uniform_issues'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON uniform_items TO onpar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON site_uniform_list TO onpar_app;
GRANT SELECT, INSERT, UPDATE ON uniform_orders TO onpar_app;
GRANT SELECT, INSERT, UPDATE ON uniform_order_lines TO onpar_app;
GRANT SELECT, INSERT ON uniform_order_history TO onpar_app;
GRANT USAGE ON SEQUENCE uniform_order_history_id_seq TO onpar_app;
GRANT SELECT, INSERT ON uniform_issues TO onpar_app;
