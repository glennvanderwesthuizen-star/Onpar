-- The shift handover (owner, 7 Oct 2026; D-45): the outgoing guard counts the shift's equipment
-- and leaves a note; the incoming guard checks it and receives it.
CREATE TABLE shift_handovers (
  id               uuid PRIMARY KEY,                       -- the phone's event id
  company_id       uuid NOT NULL REFERENCES companies(id),
  site_id          uuid NOT NULL REFERENCES sites(id),
  device_id        uuid REFERENCES devices(id),
  from_employee    uuid NOT NULL REFERENCES employees(id),
  from_attendance  uuid NOT NULL UNIQUE REFERENCES attendance(id),
  shift_name       text,
  items            jsonb NOT NULL,                         -- [{ name, expected, present, damaged }]
  note             text NOT NULL DEFAULT '',
  signed_at        timestamptz NOT NULL DEFAULT now(),
  report_id        uuid REFERENCES reports(id),           -- raised for anything missing or damaged
  to_employee      uuid REFERENCES employees(id),
  received_at      timestamptz,
  received_items   jsonb,
  received_note    text,
  received_report  uuid REFERENCES reports(id)            -- raised for a difference found on receiving
);
CREATE INDEX shift_handovers_site ON shift_handovers (site_id, signed_at DESC);
ALTER TABLE shift_handovers ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON shift_handovers USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON shift_handovers TO onpar_app;
