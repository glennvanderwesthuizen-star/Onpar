-- Visitor management, step 5 (plan approved 7 Oct 2026): scanning a visitor out, and exceptions.
-- An exception is raised when the exit does not match the entry, when a scan matches nobody on
-- site, or when a visitor is scanned in while still recorded as on site (owner, 7 Oct 2026:
-- warn the guard and let him decide, with a reason).

ALTER TABLE visits
  ADD COLUMN exit_gate_id uuid REFERENCES site_gates(id),
  ADD COLUMN exit_device_id uuid REFERENCES devices(id),
  -- How the gate knew the person leaving: their ID was scanned, or the guard confirmed it against the entry record.
  ADD COLUMN exit_person_check text CHECK (exit_person_check IN ('scan','guard')),
  -- Made on the phone, so an exit sent twice is saved once.
  ADD COLUMN exit_event_id uuid;
CREATE UNIQUE INDEX visits_exit_event ON visits (company_id, exit_event_id) WHERE exit_event_id IS NOT NULL;
CREATE INDEX visits_on_site ON visits (site_id, status) WHERE status IN ('awaiting_approval','on_site');

CREATE TABLE visit_exceptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  site_id     uuid NOT NULL REFERENCES sites(id),
  gate_id     uuid REFERENCES site_gates(id),
  -- Null for "not recorded as on site": there is no visit to tie it to.
  visit_id    uuid REFERENCES visits(id),
  type        text NOT NULL CHECK (type IN ('driver_mismatch','vehicle_mismatch','pax_mismatch','no_open_visit','no_scan_out')),
  -- Who and what was at the gate, where this site knows them. Never the numbers themselves.
  person_id   uuid REFERENCES visitor_people(id),
  vehicle_id  uuid REFERENCES visitor_vehicles(id),
  pax_out     integer CHECK (pax_out BETWEEN 0 AND 99),
  reason      text CHECK (reason IN ('passenger_driving','passengers_stayed','passengers_added','vehicle_stayed','not_scanned_in','not_scanned_out','other')),
  note        text NOT NULL DEFAULT '',
  photo_key   text,
  photo_type  text,
  -- The guard's decision: he let the visitor go (or in), or he did not.
  allowed     boolean NOT NULL,
  raised_by   uuid NOT NULL REFERENCES employees(id),
  device_id   uuid REFERENCES devices(id),
  event_id    uuid NOT NULL,
  raised_at   timestamptz NOT NULL DEFAULT now(),
  cleared_by  uuid REFERENCES users(id),
  cleared_at  timestamptz,
  clear_note  text NOT NULL DEFAULT '',
  CHECK (reason IS NOT NULL OR note <> '')
);
-- One exit can raise more than one exception (a different driver and a different passenger count).
CREATE UNIQUE INDEX visit_exceptions_event ON visit_exceptions (company_id, event_id, type, COALESCE(visit_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX visit_exceptions_site ON visit_exceptions (site_id, raised_at DESC);
CREATE INDEX visit_exceptions_visit ON visit_exceptions (visit_id);

ALTER TABLE visit_exceptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON visit_exceptions USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
-- What was raised is never changed; only its clearing is filled in afterwards.
GRANT SELECT, INSERT ON visit_exceptions TO onpar_app;
GRANT UPDATE (cleared_by, cleared_at, clear_note) ON visit_exceptions TO onpar_app;

-- A customer may switch off "your visitor has left" for themselves (spec: can be muted by the customer).
ALTER TABLE customers ADD COLUMN mute_exit_alerts boolean NOT NULL DEFAULT false;
