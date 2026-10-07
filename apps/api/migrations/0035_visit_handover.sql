-- Visitor management, step 6 (plan approved 7 Oct 2026): overstays and the shift handover.

-- A visit found to be on site past its time. One row per visit, made when it is first noticed.
CREATE TABLE visit_overstays (
  visit_id              uuid PRIMARY KEY REFERENCES visits(id),
  company_id            uuid NOT NULL REFERENCES companies(id),
  site_id               uuid NOT NULL REFERENCES sites(id),
  -- When the visitor should have left.
  due_at                timestamptz NOT NULL,
  -- When the gate was first shown it (the guard is alerted first).
  flagged_at            timestamptz NOT NULL DEFAULT now(),
  -- When the supervisor was told, because the guard had not dealt with it in the site's escalation time.
  supervisor_alerted_at timestamptz
);

-- The handover of the visitors on site from the outgoing gate guard to the incoming one.
CREATE TABLE visit_handovers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  site_id          uuid NOT NULL REFERENCES sites(id),
  gate_id          uuid NOT NULL REFERENCES site_gates(id),
  device_id        uuid REFERENCES devices(id),
  outgoing_guard   uuid NOT NULL REFERENCES employees(id),
  started_at       timestamptz NOT NULL DEFAULT now(),
  signed_off_at    timestamptz,
  on_site_count    integer,
  overstay_count   integer,
  -- Overstays the outgoing guard could not settle (he phoned, with no result).
  unresolved_count integer,
  -- Everyone on site at sign-off, with each overstay's action and note.
  snapshot         jsonb,
  incoming_guard   uuid REFERENCES employees(id),
  acknowledged_at  timestamptz,
  CHECK (incoming_guard IS NULL OR incoming_guard <> outgoing_guard)
);
CREATE INDEX visit_handovers_site ON visit_handovers (site_id, started_at DESC);
CREATE INDEX visit_handovers_guard ON visit_handovers (outgoing_guard, signed_off_at);

-- What a guard did about an overstay. Append-only.
CREATE TABLE visit_overstay_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  visit_id    uuid NOT NULL REFERENCES visits(id),
  -- The handover it was done in, if it was.
  handover_id uuid REFERENCES visit_handovers(id),
  action      text NOT NULL CHECK (action IN ('dialled','confirmed','left')),
  note        text NOT NULL DEFAULT '',
  guard_id    uuid NOT NULL REFERENCES employees(id),
  device_id   uuid REFERENCES devices(id),
  -- Made on the phone, so an action sent twice is saved once.
  event_id    uuid NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX visit_overstay_actions_event ON visit_overstay_actions (company_id, event_id);
CREATE INDEX visit_overstay_actions_visit ON visit_overstay_actions (visit_id, at);
CREATE TRIGGER visit_overstay_actions_immutable BEFORE UPDATE OR DELETE ON visit_overstay_actions FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['visit_overstays','visit_handovers','visit_overstay_actions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON visit_overstays, visit_handovers, visit_overstay_actions TO onpar_app;
GRANT UPDATE (supervisor_alerted_at) ON visit_overstays TO onpar_app;
-- A handover is filled in at sign-off and at the acknowledgement; who started it and when never change.
GRANT UPDATE (signed_off_at, on_site_count, overstay_count, unresolved_count, snapshot, incoming_guard, acknowledged_at) ON visit_handovers TO onpar_app;
