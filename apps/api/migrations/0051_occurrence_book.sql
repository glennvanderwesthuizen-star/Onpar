-- The Electronic Occurrence Book (brief section 27; owner's step 6, 8 Oct 2026). The book itself
-- is put together from existing records; this table holds only what someone writes in it by
-- hand. A written entry is never changed or removed: a correction is a new entry.
CREATE TABLE ob_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  site_id      uuid NOT NULL REFERENCES sites(id),
  -- When it happened (may be earlier than when it was written).
  occurred_at  timestamptz NOT NULL,
  text         text NOT NULL,
  -- The entry this one corrects, if any.
  corrects     uuid REFERENCES ob_entries(id),
  written_by   uuid NOT NULL REFERENCES users(id),
  written_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ob_entries_site ON ob_entries (site_id, occurred_at);
CREATE TRIGGER ob_entries_immutable BEFORE UPDATE OR DELETE ON ob_entries FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE ob_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON ob_entries USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT ON ob_entries TO onpar_app;
