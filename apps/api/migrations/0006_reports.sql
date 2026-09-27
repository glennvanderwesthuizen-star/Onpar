-- Milestone 5: reports and close-out (brief sections 6.6 and 24).

-- Who a report can be assigned to: staff or contractors (section 6.6).
CREATE TABLE people (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  name        text NOT NULL,
  role        text NOT NULL,             -- e.g. Plumber, Electrician, Site handyman
  phone       text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('internal','contractor')),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Per-site routing: which roles receive reports of each priority. Null uses the default.
ALTER TABLE sites ADD COLUMN report_routing jsonb;

CREATE TABLE reports (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL REFERENCES companies(id),
  number                 integer NOT NULL,
  site_id                uuid NOT NULL REFERENCES sites(id),
  category               text NOT NULL CHECK (category IN ('security','safety','injury','maintenance','equipment',
                                                           'client_issue','staff_issue','observation','other')),
  priority               text NOT NULL CHECK (priority IN ('green','amber','red')),
  description            text NOT NULL,
  photo_key              text,
  photo_content_type     text,
  photo_pending          boolean NOT NULL DEFAULT false,
  stage                  text NOT NULL DEFAULT 'reported'
                           CHECK (stage IN ('reported','assigned','actioned','attendance_checked','job_inspected','closed')),
  assignee_person_id     uuid REFERENCES people(id),
  colour_slot            smallint NOT NULL,
  -- Who reported it: a guard on a device, or a management user.
  reported_by_employee   uuid REFERENCES employees(id),
  reported_by_user       uuid REFERENCES users(id),
  device_id              uuid REFERENCES devices(id),
  -- Where it came from: a guard or user, or automatically from a declaration comment.
  source                 text NOT NULL CHECK (source IN ('guard','user','declaration','patrol')),
  source_id              uuid,
  -- Injury reports point to the reporter's Duty On declaration for that shift (section 6.2).
  linked_attendance_id   uuid REFERENCES attendance(id),
  -- Set when an officer follows up, cleared when the higher level next acts.
  needs_attention        boolean NOT NULL DEFAULT false,
  reported_at            timestamptz NOT NULL,
  received_at            timestamptz NOT NULL DEFAULT now(),
  late_synced            boolean NOT NULL DEFAULT false,
  event_id               uuid UNIQUE,     -- device event ID, so a retry never creates a second report
  closed_at              timestamptz,
  UNIQUE (company_id, number),
  CHECK ((reported_by_employee IS NULL) <> (reported_by_user IS NULL))
);
CREATE INDEX reports_site_stage ON reports (site_id, stage);
-- A declaration comment becomes at most one report.
CREATE UNIQUE INDEX reports_from_source ON reports (source, source_id) WHERE source_id IS NOT NULL;

-- Everyone the report was routed to when it was made.
CREATE TABLE report_recipients (
  company_id  uuid NOT NULL REFERENCES companies(id),
  report_id   uuid NOT NULL REFERENCES reports(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY (report_id, user_id)
);

-- Every stage and follow-up: who, their role, a note, the time. Append-only.
CREATE TABLE report_history (
  id                  bigserial PRIMARY KEY,
  company_id          uuid NOT NULL REFERENCES companies(id),
  report_id           uuid NOT NULL REFERENCES reports(id),
  at                  timestamptz NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  actor_type          text NOT NULL CHECK (actor_type IN ('user','employee','system')),
  actor_id            uuid,
  actor_label         text NOT NULL DEFAULT '',
  actor_role          text NOT NULL DEFAULT '',
  action              text NOT NULL,         -- a stage name, 'follow_up' or 'note'
  stage_after         text NOT NULL,
  outcome             text CHECK (outcome IN ('not_started','in_progress','done_ok','not_fixed')),
  note                text NOT NULL DEFAULT '',
  assignee_person_id  uuid REFERENCES people(id),
  photo_key           text,
  photo_content_type  text,
  event_id            uuid UNIQUE,
  late_synced         boolean NOT NULL DEFAULT false
);
CREATE INDEX report_history_report ON report_history (report_id, at, id);
CREATE TRIGGER report_history_immutable BEFORE UPDATE OR DELETE ON report_history
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- The inspection task an officer on site is sent (section 6.6).
ALTER TABLE tasks ADD COLUMN report_id uuid REFERENCES reports(id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['people','reports','report_recipients','report_history'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id())
                    WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON people, reports TO onpar_app;
GRANT SELECT, INSERT ON report_recipients, report_history TO onpar_app;
GRANT USAGE ON SEQUENCE report_history_id_seq TO onpar_app;
