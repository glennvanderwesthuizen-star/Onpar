-- Milestone 7: re-orders and issued kit (brief section 6.7).

-- The company's kit list. Empty means the standard list in the rules package.
CREATE TABLE kit_catalogue (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  name        text NOT NULL,
  tracking    text NOT NULL CHECK (tracking IN ('size','asset')),
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX kit_catalogue_name ON kit_catalogue (company_id, lower(name));

ALTER TABLE issued_items ADD COLUMN updated_at timestamptz;

CREATE TABLE reorders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id),
  number              integer NOT NULL,
  site_id             uuid NOT NULL REFERENCES sites(id),
  employee_id         uuid NOT NULL REFERENCES employees(id),
  device_id           uuid REFERENCES devices(id),
  kind                text NOT NULL CHECK (kind IN ('personal','site')),
  -- Personal: the issued item it replaces; size or asset number filled from the profile.
  issued_item_id      uuid REFERENCES issued_items(id),
  item                text NOT NULL,
  size                text,
  asset_number        text,
  quantity            text,            -- site re-orders: free text, e.g. "2 packs"
  comment             text NOT NULL DEFAULT '',
  stage               text NOT NULL DEFAULT 'requested'
                        CHECK (stage IN ('requested','ordered','assigned','delivered','received')),
  assignee_person_id  uuid REFERENCES people(id),
  requested_at        timestamptz NOT NULL,
  received_at         timestamptz,
  late_synced         boolean NOT NULL DEFAULT false,
  event_id            uuid UNIQUE,
  UNIQUE (company_id, number),
  CHECK ((kind = 'personal') = (issued_item_id IS NOT NULL))
);
CREATE INDEX reorders_site_stage ON reorders (site_id, stage);

-- Every stage: who, role, note, time. Append-only.
CREATE TABLE reorder_history (
  id                  bigserial PRIMARY KEY,
  company_id          uuid NOT NULL REFERENCES companies(id),
  reorder_id          uuid NOT NULL REFERENCES reorders(id),
  at                  timestamptz NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  actor_type          text NOT NULL CHECK (actor_type IN ('user','employee')),
  actor_id            uuid,
  actor_label         text NOT NULL,
  actor_role          text NOT NULL,
  stage_after         text NOT NULL,
  note                text NOT NULL DEFAULT '',
  assignee_person_id  uuid REFERENCES people(id),
  event_id            uuid UNIQUE,
  late_synced         boolean NOT NULL DEFAULT false
);
CREATE INDEX reorder_history_reorder ON reorder_history (reorder_id, at, id);
CREATE TRIGGER reorder_history_immutable BEFORE UPDATE OR DELETE ON reorder_history FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kit_catalogue','reorders','reorder_history'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id())
                    WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON kit_catalogue TO onpar_app;
GRANT SELECT, INSERT, UPDATE ON reorders TO onpar_app;
GRANT SELECT, INSERT ON reorder_history TO onpar_app;
GRANT USAGE ON SEQUENCE reorder_history_id_seq TO onpar_app;
