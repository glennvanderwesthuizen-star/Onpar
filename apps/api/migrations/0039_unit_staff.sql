-- Staff of a unit (owner, 7 Oct 2026; D-47): cleaners, gardeners and other people who work for
-- a tenant. Registered by the tenant or the administrator. At the gate they give the last six
-- digits of their cell number; on the first day the guard scans their ID and takes a reference
-- photo; on later days a snapshot is compared with it. The comparison advises, the guard decides.

CREATE TABLE unit_staff (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  site_id        uuid NOT NULL REFERENCES sites(id),
  -- The unit they work for. Null: the client (the office).
  unit_id        uuid REFERENCES site_units(id),
  full_name      text NOT NULL,
  -- In their compared forms.
  cell           text NOT NULL,
  -- What they give at the gate: the last six digits of the cell number.
  code           text NOT NULL CHECK (code ~ '^[0-9]{6}$'),
  -- Optional. When given, the ID scanned on the first day must be this one.
  id_number      text,
  -- Days of the week, 1 Monday to 7 Sunday. Null: every day.
  days           smallint[],
  hours_from     time,
  hours_to       time,
  end_date       date,
  added_by_customer uuid REFERENCES customers(id),
  added_by_user  uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  removed_at     timestamptz,
  removed_by_customer uuid REFERENCES customers(id),
  removed_by_user uuid REFERENCES users(id),
  -- Filled in on the first arrival: who they are from their ID, and the reference photo.
  person_id      uuid REFERENCES visitor_people(id),
  identity_document text,
  ref_photo_key  text,
  ref_photo_type text,
  enrolled_at    timestamptz,
  enrolled_by    uuid REFERENCES employees(id),
  CHECK ((added_by_customer IS NULL) <> (added_by_user IS NULL)),
  CHECK ((hours_from IS NULL) = (hours_to IS NULL))
);
CREATE INDEX unit_staff_code ON unit_staff (site_id, code) WHERE removed_at IS NULL;
CREATE INDEX unit_staff_unit ON unit_staff (unit_id);
ALTER TABLE unit_staff ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON unit_staff USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON unit_staff TO onpar_app;

-- A staff member's day on site is a visit like any other, so they are on the on-site list and in the handover.
ALTER TABLE visits ADD COLUMN staff_id uuid REFERENCES unit_staff(id);
CREATE INDEX visits_staff ON visits (staff_id) WHERE staff_id IS NOT NULL;
-- No document is scanned on an ordinary day: the entry is by their code and photo.
ALTER TABLE visits DROP CONSTRAINT visits_capture_method_check;
ALTER TABLE visits ADD CONSTRAINT visits_capture_method_check CHECK (capture_method IN ('scan','manual','staff'));
ALTER TABLE visits DROP CONSTRAINT visits_identity_method_check;
ALTER TABLE visits ADD CONSTRAINT visits_identity_method_check CHECK (identity_method IN ('scan','manual','staff'));

-- The guard doubted the photo, or the automatic comparison did.
ALTER TABLE visit_exceptions DROP CONSTRAINT visit_exceptions_type_check;
ALTER TABLE visit_exceptions ADD CONSTRAINT visit_exceptions_type_check CHECK (type IN ('driver_mismatch','vehicle_mismatch','pax_mismatch','no_open_visit','no_scan_out','face_mismatch'));
ALTER TABLE visit_exceptions ADD COLUMN staff_id uuid REFERENCES unit_staff(id);
