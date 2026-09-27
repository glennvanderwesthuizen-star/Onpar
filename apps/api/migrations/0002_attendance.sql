-- Milestone 2: Duty On, Duty From, declarations and attendance (brief sections 6.2, 6.3, 8).

ALTER TABLE companies ADD COLUMN grace_minutes smallint NOT NULL DEFAULT 5 CHECK (grace_minutes BETWEEN 0 AND 60);

-- One row per guard per shift worked, updated as the shift progresses.
CREATE TABLE attendance (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL REFERENCES companies(id),
  employee_id            uuid NOT NULL REFERENCES employees(id),
  site_id                uuid NOT NULL REFERENCES sites(id),
  shift_id               uuid REFERENCES site_shifts(id) ON DELETE SET NULL,
  shift_name             text,
  shift_date             date NOT NULL,
  scheduled_start        timestamptz,
  scheduled_end          timestamptz,
  duty_on_at             timestamptz NOT NULL,
  duty_from_at           timestamptz,
  arrival_status         text NOT NULL CHECK (arrival_status IN ('ON_TIME','LATE','UNSCHEDULED')),
  late_minutes           integer NOT NULL DEFAULT 0,
  departure_status       text CHECK (departure_status IN ('ON_TIME','EARLY_DEPARTURE','UNSCHEDULED')),
  early_minutes          integer NOT NULL DEFAULT 0,
  exception_approved_by  uuid REFERENCES users(id),
  exception_reason       text,
  exception_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attendance_site_date ON attendance (site_id, shift_date);
CREATE INDEX attendance_employee ON attendance (employee_id, duty_on_at DESC);
-- A guard can have only one open shift at a time.
CREATE UNIQUE INDEX attendance_one_open ON attendance (employee_id) WHERE duty_from_at IS NULL;

-- Each press of Duty On or Duty From. Immutable.
CREATE TABLE duty_events (
  id                uuid PRIMARY KEY,           -- generated on the device; retries reuse it
  company_id        uuid NOT NULL REFERENCES companies(id),
  attendance_id     uuid NOT NULL REFERENCES attendance(id),
  employee_id       uuid NOT NULL REFERENCES employees(id),
  device_id         uuid REFERENCES devices(id),
  kind              text NOT NULL CHECK (kind IN ('duty_on','duty_from')),
  official_at       timestamptz NOT NULL,
  trusted_at        timestamptz NOT NULL,
  device_clock      timestamptz NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  late_synced       boolean NOT NULL,
  drift_seconds     integer NOT NULL,
  drift_flagged     boolean NOT NULL,
  on_behalf_by      uuid REFERENCES users(id),   -- a supervisor logged it for the guard
  on_behalf_reason  text,
  UNIQUE (attendance_id, kind)
);

-- The declaration that follows each duty event. Immutable, except that a
-- selfie sent after the text (photos sync last) may be attached once.
CREATE TABLE declarations (
  id                      uuid PRIMARY KEY,     -- generated on the device
  company_id              uuid NOT NULL REFERENCES companies(id),
  attendance_id           uuid NOT NULL REFERENCES attendance(id),
  duty_event_id           uuid NOT NULL REFERENCES duty_events(id),
  employee_id             uuid NOT NULL REFERENCES employees(id),
  device_id               uuid REFERENCES devices(id),
  kind                    text NOT NULL CHECK (kind IN ('duty_on','duty_from')),
  wording_version         integer NOT NULL,
  statements              jsonb NOT NULL,       -- [{ text, accepted }], exactly as shown
  comment                 text NOT NULL DEFAULT '',
  raise_equipment_report  boolean NOT NULL DEFAULT false,
  official_at             timestamptz NOT NULL,
  device_clock            timestamptz NOT NULL,
  received_at             timestamptz NOT NULL DEFAULT now(),
  late_synced             boolean NOT NULL,
  drift_seconds           integer NOT NULL,
  drift_flagged           boolean NOT NULL,
  selfie_key              text,
  selfie_content_type     text,
  selfie_received_at      timestamptz,
  UNIQUE (attendance_id, kind)
);

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% records are immutable', TG_TABLE_NAME;
END $$;
CREATE TRIGGER duty_events_immutable BEFORE UPDATE OR DELETE ON duty_events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION declarations_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.selfie_key IS NULL AND NEW.selfie_key IS NOT NULL
     AND (to_jsonb(NEW) - 'selfie_key' - 'selfie_content_type' - 'selfie_received_at')
       = (to_jsonb(OLD) - 'selfie_key' - 'selfie_content_type' - 'selfie_received_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'declarations are immutable';
END $$;
CREATE TRIGGER declarations_immutable BEFORE UPDATE OR DELETE ON declarations
  FOR EACH ROW EXECUTE FUNCTION declarations_immutable();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['attendance','duty_events','declarations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id())
                    WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON attendance TO onpar_app;
GRANT SELECT, INSERT ON duty_events TO onpar_app;
GRANT SELECT, INSERT, UPDATE ON declarations TO onpar_app;
