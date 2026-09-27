-- Milestone 10: POPIA retention (brief section 9). The periods are proposals for
-- legal to confirm, so removal stays OFF until a company switches it on.
CREATE TABLE retention_settings (
  company_id           uuid PRIMARY KEY REFERENCES companies(id),
  enabled              boolean NOT NULL DEFAULT false,
  selfie_months        integer NOT NULL DEFAULT 12 CHECK (selfie_months BETWEEN 1 AND 120),
  patrol_photo_months  integer NOT NULL DEFAULT 12 CHECK (patrol_photo_months BETWEEN 1 AND 120),
  updated_by           uuid REFERENCES users(id),
  updated_at           timestamptz
);

-- Every photo removed under retention: the record it belonged to stays, only the image goes. Append-only.
CREATE TABLE retention_log (
  id           bigserial PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies(id),
  kind         text NOT NULL CHECK (kind IN ('selfie','patrol_photo')),
  storage_key  text NOT NULL UNIQUE,
  source_id    uuid NOT NULL,
  taken_at     timestamptz NOT NULL,
  removed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER retention_log_immutable BEFORE UPDATE OR DELETE ON retention_log FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['retention_settings','retention_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON retention_settings TO onpar_app;
GRANT SELECT, INSERT ON retention_log TO onpar_app;
GRANT USAGE ON SEQUENCE retention_log_id_seq TO onpar_app;
