-- Visitor management, step 2 (plan approved 7 Oct 2026): scanning a visitor in at a gate.
-- Only the fields the spec lists are kept from a scan. A photo of a document is kept only when
-- the guard had to type its details by hand; a face photo only for a visitor on foot.

-- A post phone set up as a gate phone belongs to one gate of its site.
ALTER TABLE devices ADD COLUMN gate_id uuid REFERENCES site_gates(id);

-- A person who has visited a site. Kept per site: a guard sees only his own site's visitors.
CREATE TABLE visitor_people (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  site_id     uuid NOT NULL REFERENCES sites(id),
  -- In its compared form (capitals and digits only). A passport or foreign ID is allowed.
  id_number   text NOT NULL,
  surname     text NOT NULL DEFAULT '',
  -- Full names from an ID, or initials from a driver's licence.
  names       text NOT NULL DEFAULT '',
  cell        text NOT NULL DEFAULT '',
  first_seen  timestamptz NOT NULL,
  last_seen   timestamptz NOT NULL
);
CREATE UNIQUE INDEX visitor_people_id ON visitor_people (site_id, id_number);

CREATE TABLE visitor_vehicles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  site_id       uuid NOT NULL REFERENCES sites(id),
  -- In its compared form (capitals and digits only).
  registration  text NOT NULL,
  make          text NOT NULL DEFAULT '',
  model         text NOT NULL DEFAULT '',
  colour        text NOT NULL DEFAULT '',
  vin           text NOT NULL DEFAULT '',
  first_seen    timestamptz NOT NULL,
  last_seen     timestamptz NOT NULL
);
CREATE UNIQUE INDEX visitor_vehicles_reg ON visitor_vehicles (site_id, registration);

-- The visit: one person, one optional vehicle and one unit, from entry to exit.
CREATE TABLE visits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id),
  site_id           uuid NOT NULL REFERENCES sites(id),
  gate_id           uuid NOT NULL REFERENCES site_gates(id),
  device_id         uuid REFERENCES devices(id),
  -- Made on the phone, so a visit sent twice (a dropped connection) is saved once.
  event_id          uuid NOT NULL,
  type              text NOT NULL CHECK (type IN ('vehicle','pedestrian')),
  person_id         uuid NOT NULL REFERENCES visitor_people(id),
  vehicle_id        uuid REFERENCES visitor_vehicles(id),
  category_id       uuid NOT NULL REFERENCES visitor_categories(id),
  -- The unit visited. Null: the client (the estate office or body corporate).
  unit_id           uuid REFERENCES site_units(id),
  announced         boolean NOT NULL DEFAULT false,
  pax_in            integer CHECK (pax_in BETWEEN 0 AND 99),
  pax_out           integer CHECK (pax_out BETWEEN 0 AND 99),
  status            text NOT NULL CHECK (status IN ('awaiting_approval','on_site','exited','exited_exception','denied','denied_no_response','left_no_scan_out')),
  -- Why a visit was denied without asking the customer, for example 'barred'.
  denied_reason     text,
  -- 'manual' when any document had to be typed in by the guard.
  capture_method    text NOT NULL CHECK (capture_method IN ('scan','manual')),
  identity_document text NOT NULL CHECK (identity_document IN ('id_card','id_book','drivers_licence','passport','other')),
  identity_method   text NOT NULL CHECK (identity_method IN ('scan','manual')),
  disc_method       text CHECK (disc_method IN ('scan','manual')),
  licence_expiry    date,
  disc_expiry       date,
  -- What the checks found and what the guard accepted, for example {"barred":[...],"warnings":["disc_expired"]}.
  checks            jsonb NOT NULL DEFAULT '{}',
  captured_offline  boolean NOT NULL DEFAULT false,
  captured_at       timestamptz NOT NULL,
  late_synced       boolean NOT NULL DEFAULT false,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  entry_at          timestamptz,
  exit_at           timestamptz,
  entry_guard       uuid NOT NULL REFERENCES employees(id),
  exit_guard        uuid REFERENCES employees(id),
  -- Pedestrians only.
  face_photo_key    text,
  face_photo_type   text,
  CHECK ((type = 'vehicle') = (vehicle_id IS NOT NULL))
);
CREATE UNIQUE INDEX visits_event ON visits (company_id, event_id);
CREATE INDEX visits_site_time ON visits (site_id, captured_at DESC);
CREATE INDEX visits_person ON visits (person_id);
CREATE INDEX visits_vehicle ON visits (vehicle_id);

-- A photo of a document, kept only when its details were typed by hand (spec: manual capture).
CREATE TABLE visit_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  visit_id      uuid NOT NULL REFERENCES visits(id),
  kind          text NOT NULL CHECK (kind IN ('identity','licence_disc')),
  storage_key   text NOT NULL,
  content_type  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX visit_documents_kind ON visit_documents (visit_id, kind);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['visitor_people','visitor_vehicles','visits','visit_documents']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON visitor_people, visitor_vehicles, visits TO onpar_app;
GRANT SELECT, INSERT ON visit_documents TO onpar_app;
