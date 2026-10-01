-- First versions of Panic and BOLO (decisions D-27, D-28). Both can be raised from the
-- post phone without a guard signed in; the guard is recorded when one is.

-- A panic pressed on a post phone. The phone's location is taken once, at the moment
-- of the panic (owner's decision D-28). The alert itself never changes; only its
-- acknowledgement and resolution are filled in, once each.
CREATE TABLE panic_alerts (
  id               uuid PRIMARY KEY,                -- generated on the phone; retries reuse it
  company_id       uuid NOT NULL REFERENCES companies(id),
  device_id        uuid NOT NULL REFERENCES devices(id),
  site_id          uuid REFERENCES sites(id),
  employee_id      uuid REFERENCES employees(id),
  raised_at        timestamptz NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  late_synced      boolean NOT NULL DEFAULT false,
  lat              double precision,
  lng              double precision,
  accuracy_m       double precision,
  location_mock    boolean NOT NULL DEFAULT false,
  call_started     boolean NOT NULL DEFAULT false,  -- the phone began a call to the control room
  acknowledged_at  timestamptz,
  acknowledged_by  uuid REFERENCES users(id),
  resolved_at      timestamptz,
  resolved_by      uuid REFERENCES users(id),
  resolution_note  text
);
CREATE INDEX panic_alerts_open ON panic_alerts (company_id, raised_at DESC) WHERE resolved_at IS NULL;

CREATE FUNCTION panic_alerts_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'acknowledged_at' - 'acknowledged_by' - 'resolved_at' - 'resolved_by' - 'resolution_note')
       = (to_jsonb(OLD) - 'acknowledged_at' - 'acknowledged_by' - 'resolved_at' - 'resolved_by' - 'resolution_note')
     AND (OLD.acknowledged_at IS NULL OR (NEW.acknowledged_at = OLD.acknowledged_at
                                          AND NEW.acknowledged_by IS NOT DISTINCT FROM OLD.acknowledged_by))
     AND (OLD.resolved_at IS NULL OR (NEW.resolved_at = OLD.resolved_at
                                      AND NEW.resolved_by IS NOT DISTINCT FROM OLD.resolved_by
                                      AND NEW.resolution_note IS NOT DISTINCT FROM OLD.resolution_note)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'panic_alerts records are immutable';
END $$;
CREATE TRIGGER panic_alerts_immutable BEFORE UPDATE OR DELETE ON panic_alerts
  FOR EACH ROW EXECUTE FUNCTION panic_alerts_immutable();

-- "Be on the lookout": a photo and a short note from a post phone. Immutable.
CREATE TABLE bolos (
  id                  uuid PRIMARY KEY,             -- generated on the phone
  company_id          uuid NOT NULL REFERENCES companies(id),
  device_id           uuid NOT NULL REFERENCES devices(id),
  site_id             uuid REFERENCES sites(id),
  employee_id         uuid REFERENCES employees(id),
  note                text NOT NULL,
  photo_key           text,
  photo_content_type  text,
  reported_at         timestamptz NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  late_synced         boolean NOT NULL DEFAULT false
);
CREATE INDEX bolos_site ON bolos (site_id, reported_at DESC);
CREATE TRIGGER bolos_immutable BEFORE UPDATE OR DELETE ON bolos FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['panic_alerts','bolos'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON panic_alerts TO onpar_app;
GRANT SELECT, INSERT ON bolos TO onpar_app;
