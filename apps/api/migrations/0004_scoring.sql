-- Milestone 4: the scoring engine (brief section 6.8).

-- Company scoring settings. Anything not stored uses the defaults in the rules package.
CREATE TABLE scoring_settings (
  company_id  uuid PRIMARY KEY REFERENCES companies(id),
  config      jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Every point gained or lost, and why. Append-only: a correction is a new
-- event that reverses an earlier one, never an edit or a deletion.
CREATE TABLE performance_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id),
  employee_id        uuid NOT NULL REFERENCES employees(id),
  site_id            uuid REFERENCES sites(id),
  event_date         date NOT NULL,           -- the SAST day it counts on
  event_type         text NOT NULL,           -- a rules-package event type, or 'reversal'
  impact             numeric(6,2) NOT NULL,   -- the points at the time, so later rule changes affect only later events
  source_type        text NOT NULL CHECK (source_type IN ('attendance','task','manual','reversal','report','training','patrol')),
  source_id          uuid,
  evidence           text NOT NULL,
  reverses_event_id  uuid UNIQUE REFERENCES performance_events(id),
  created_by_type    text NOT NULL CHECK (created_by_type IN ('system','user')),
  created_by         uuid REFERENCES users(id),
  created_by_label   text NOT NULL DEFAULT '',
  reason             text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((event_type = 'reversal') = (reverses_event_id IS NOT NULL))
);
CREATE INDEX performance_events_employee ON performance_events (employee_id, event_date);
-- One automatic event per source and type, so re-running a hook never double counts.
CREATE UNIQUE INDEX performance_events_once ON performance_events (source_type, source_id, event_type)
  WHERE source_id IS NOT NULL AND reverses_event_id IS NULL AND source_type <> 'manual';
CREATE TRIGGER performance_events_immutable BEFORE UPDATE OR DELETE ON performance_events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- An employee questioning a negative event (section 6.8). One per event.
CREATE TABLE score_queries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  event_id      uuid NOT NULL UNIQUE REFERENCES performance_events(id),
  employee_id   uuid NOT NULL REFERENCES employees(id),
  text          text NOT NULL,
  asked_at      timestamptz NOT NULL DEFAULT now(),
  answer_due    date NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','upheld','reversed')),
  answer        text,
  answered_by   uuid REFERENCES users(id),
  answered_at   timestamptz
);
CREATE INDEX score_queries_open ON score_queries (answer_due) WHERE status = 'open';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['scoring_settings','performance_events','score_queries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id())
                    WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON scoring_settings, score_queries TO onpar_app;
GRANT SELECT, INSERT ON performance_events TO onpar_app;
