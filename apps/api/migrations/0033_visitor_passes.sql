-- Visitor management, step 4 (plan approved 7 Oct 2026): announced visitors.
-- A customer tells the gate in advance who is coming: for one visit (the spec's
-- pre-registration) or as a regular (the spec's standing approval). A visitor who matches a
-- pass at the gate is let in without the customer being asked again.

CREATE TABLE visitor_passes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  site_id       uuid NOT NULL REFERENCES sites(id),
  -- The unit the visitor is for. Null: the client (the office).
  unit_id       uuid REFERENCES site_units(id),
  created_by    uuid NOT NULL REFERENCES customers(id),
  category_id   uuid NOT NULL REFERENCES visitor_categories(id),
  -- The gate the customer named. A visitor is still let in at any gate of the site (owner, 7 Oct 2026).
  gate_id       uuid REFERENCES site_gates(id),
  visitor_name  text NOT NULL,
  -- At least one of these, each in its compared form.
  id_number     text,
  cell          text,
  registration  text,
  -- 'once': one visit on a date. 'ongoing': a regular, on set days and hours, or between two dates.
  kind          text NOT NULL CHECK (kind IN ('once','ongoing')),
  visit_date    date,
  -- With a time, the visitor matches from one hour before to one hour after.
  time_from     time,
  -- Days of the week, 1 Monday to 7 Sunday. Null: every day.
  days          smallint[],
  hours_from    time,
  hours_to      time,
  start_date    date,
  end_date      date,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','cancelled')),
  used_at       timestamptz,
  used_visit_id uuid REFERENCES visits(id),
  cancelled_at  timestamptz,
  cancelled_by  uuid REFERENCES customers(id),
  -- When the customer was told a fixed-period pass is about to end.
  expiry_told_at timestamptz,
  -- The approved visit this pass was made from ("let them in next time"), if any.
  from_visit_id uuid REFERENCES visits(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (id_number IS NOT NULL OR cell IS NOT NULL OR registration IS NOT NULL),
  CHECK (kind <> 'once' OR visit_date IS NOT NULL),
  CHECK ((hours_from IS NULL) = (hours_to IS NULL))
);
CREATE INDEX visitor_passes_site ON visitor_passes (site_id, status);
CREATE INDEX visitor_passes_unit ON visitor_passes (unit_id);

ALTER TABLE visitor_passes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON visitor_passes USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON visitor_passes TO onpar_app;

-- A visit let in on a pass.
ALTER TABLE visits ADD COLUMN pass_id uuid REFERENCES visitor_passes(id);

-- Let in on a pass is a third way a visit is approved, beside the app and the phone.
ALTER TABLE visit_approvals DROP CONSTRAINT visit_approvals_method_check;
ALTER TABLE visit_approvals ADD CONSTRAINT visit_approvals_method_check CHECK (method IN ('push','phone','pass'));
