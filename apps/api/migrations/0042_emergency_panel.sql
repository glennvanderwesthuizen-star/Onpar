-- The emergency panel (owner, 7 Oct 2026): after PANIC, and on the Call screen, the guard can
-- phone the police, the fire brigade, an ambulance or the site's armed response company.

-- A site's own emergency numbers sit with its other approved contacts.
ALTER TABLE site_contacts DROP CONSTRAINT site_contacts_kind_check;
ALTER TABLE site_contacts ADD CONSTRAINT site_contacts_kind_check
  CHECK (kind IN ('supervisor','site_manager','control_room','police_station','fire','ambulance','armed_response'));

-- The armed response company's logo, shown on its button on the phone.
ALTER TABLE sites ADD COLUMN armed_response_logo_key text, ADD COLUMN armed_response_logo_type text;

-- Each time a guard taps an emergency number. A record of what was dialled, never changed.
CREATE TABLE emergency_calls (
  id           uuid PRIMARY KEY,                       -- the phone's event id, so a retry is recorded once
  company_id   uuid NOT NULL REFERENCES companies(id),
  site_id      uuid REFERENCES sites(id),
  device_id    uuid NOT NULL REFERENCES devices(id),
  employee_id  uuid REFERENCES employees(id),          -- the guard signed in, if any
  panic_id     uuid,                                   -- the panic it followed, if any (no link: with no signal the call record can arrive first)
  service      text NOT NULL CHECK (service IN ('police','fire','ambulance','armed_response')),
  option_kind  text NOT NULL,
  national     boolean NOT NULL,
  called_at    timestamptz NOT NULL,
  late_synced  boolean NOT NULL DEFAULT false,
  received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX emergency_calls_site ON emergency_calls (site_id, called_at DESC);
CREATE INDEX emergency_calls_panic ON emergency_calls (panic_id);
ALTER TABLE emergency_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON emergency_calls USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT ON emergency_calls TO onpar_app;
CREATE TRIGGER emergency_calls_immutable BEFORE UPDATE OR DELETE ON emergency_calls FOR EACH ROW EXECUTE FUNCTION forbid_change();
