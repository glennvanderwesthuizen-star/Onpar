-- The Wire, step 2 (owner, 8 Oct 2026): Thuthuka notes and awards approved by a person.

-- A guard's improvement suggestion (Kaizen tradition), with the decision and its reason.
CREATE TABLE wire_notes (
  id               uuid PRIMARY KEY,                 -- the phone's event id, so a retry is one note
  company_id       uuid NOT NULL REFERENCES companies(id),
  employee_id      uuid NOT NULL REFERENCES employees(id),
  site_id          uuid REFERENCES sites(id),
  noticed          text NOT NULL,
  suggestion       text NOT NULL,
  improves         text NOT NULL,
  photo_key        text,
  photo_type       text,
  status           text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','under_review','adopted','declined')),
  reason           text NOT NULL DEFAULT '',
  decided_by       uuid REFERENCES users(id),
  sent_at          timestamptz NOT NULL DEFAULT now(),
  acknowledged_at  timestamptz,
  decided_at       timestamptz
);
CREATE INDEX wire_notes_open ON wire_notes (company_id, status, sent_at);
CREATE INDEX wire_notes_guard ON wire_notes (employee_id, sent_at DESC);

-- Customer praise and recognition awards: proposed by a person or by the system, decided by the owner.
CREATE TABLE wire_awards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  employee_id  uuid NOT NULL REFERENCES employees(id),
  site_id      uuid REFERENCES sites(id),
  kind         text NOT NULL CHECK (kind IN ('customer_praise','discretionary')),
  barbs        integer NOT NULL CHECK (barbs > 0),
  why          text NOT NULL,
  -- A suggestion the system raised once, so it is not raised again.
  source_key   text,
  raised_by    uuid REFERENCES users(id),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  reason       text NOT NULL DEFAULT '',
  decided_by   uuid REFERENCES users(id),
  raised_at    timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  UNIQUE (employee_id, source_key)
);
CREATE INDEX wire_awards_open ON wire_awards (company_id, status, raised_at);

ALTER TABLE wire_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE wire_awards ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON wire_notes USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
CREATE POLICY tenant ON wire_awards USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON wire_notes, wire_awards TO onpar_app;
