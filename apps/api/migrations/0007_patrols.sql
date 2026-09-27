-- Milestone 6: patrols (brief section 6.5).

-- Each site shift has one patrol points allocation, shared across all its required patrols.
ALTER TABLE site_shifts ADD COLUMN patrol_points numeric(6,2) NOT NULL DEFAULT 0 CHECK (patrol_points >= 0);

-- A kind of patrol at a site, e.g. A internal, B perimeter, C guard-room check-in (single scan).
CREATE TABLE patrol_types (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  site_id      uuid NOT NULL REFERENCES sites(id),
  code         text NOT NULL,
  name         text NOT NULL,
  single_scan  boolean NOT NULL DEFAULT false,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, code)
);

-- The three rules, per patrol type and per site shift, so day and night can differ.
CREATE TABLE patrol_rules (
  company_id            uuid NOT NULL REFERENCES companies(id),
  patrol_type_id        uuid NOT NULL REFERENCES patrol_types(id),
  shift_id              uuid NOT NULL REFERENCES site_shifts(id) ON DELETE CASCADE,
  per_shift             integer NOT NULL CHECK (per_shift BETWEEN 1 AND 48),
  min_gap_minutes       integer NOT NULL CHECK (min_gap_minutes >= 0),
  max_duration_minutes  integer NOT NULL CHECK (max_duration_minutes >= 1),
  PRIMARY KEY (patrol_type_id, shift_id)
);

CREATE TABLE patrol_points (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  site_id         uuid NOT NULL REFERENCES sites(id),
  patrol_type_id  uuid NOT NULL REFERENCES patrol_types(id),
  name            text NOT NULL,
  qr_code         text NOT NULL UNIQUE,
  lat             double precision NOT NULL,
  lng             double precision NOT NULL,
  radius_m        integer NOT NULL DEFAULT 30 CHECK (radius_m BETWEEN 5 AND 500),
  instruction     text NOT NULL DEFAULT '',
  photo_mode      text NOT NULL DEFAULT 'off' CHECK (photo_mode IN ('off','optional','required')),
  note_mode       text NOT NULL DEFAULT 'off' CHECK (note_mode IN ('off','optional','required')),
  checks          jsonb NOT NULL DEFAULT '[]',
  active          boolean NOT NULL DEFAULT true,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX patrol_points_type ON patrol_points (patrol_type_id);

-- One patrol by one guard in one window of their shift.
CREATE TABLE patrol_instances (
  id                    uuid PRIMARY KEY,           -- made on the device for patrols, by the server for missed windows
  company_id            uuid NOT NULL REFERENCES companies(id),
  site_id               uuid NOT NULL REFERENCES sites(id),
  patrol_type_id        uuid NOT NULL REFERENCES patrol_types(id),
  attendance_id         uuid NOT NULL REFERENCES attendance(id),
  employee_id           uuid NOT NULL REFERENCES employees(id),
  device_id             uuid REFERENCES devices(id),
  window_index          integer NOT NULL,
  window_start          timestamptz NOT NULL,
  window_end            timestamptz NOT NULL,
  state                 text NOT NULL CHECK (state IN ('active','completed','partial','missed')),
  started_at            timestamptz,
  finished_at           timestamptz,
  max_duration_minutes  integer NOT NULL,
  partial_reason        text,
  review                text CHECK (review IN ('accepted','not_accepted')),
  reviewed_by           uuid REFERENCES users(id),
  review_note           text,
  points_earned         numeric(6,2) NOT NULL DEFAULT 0,
  UNIQUE (attendance_id, patrol_type_id, window_index)
);
-- Only one patrol in progress per guard.
CREATE UNIQUE INDEX patrol_one_active ON patrol_instances (employee_id) WHERE state = 'active';

-- Every scan, accepted or not. Append-only: rejected scans are evidence too.
CREATE TABLE patrol_scans (
  id           uuid PRIMARY KEY,                    -- device event ID
  company_id   uuid NOT NULL REFERENCES companies(id),
  patrol_id    uuid REFERENCES patrol_instances(id),
  point_id     uuid REFERENCES patrol_points(id),
  employee_id  uuid NOT NULL REFERENCES employees(id),
  device_id    uuid REFERENCES devices(id),
  qr_code      text NOT NULL,
  lat          double precision,
  lng          double precision,
  accuracy_m   double precision,
  distance_m   integer,
  result       text NOT NULL,
  official_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  late_synced  boolean NOT NULL DEFAULT false
);
CREATE INDEX patrol_scans_patrol ON patrol_scans (patrol_id, official_at);
CREATE TRIGGER patrol_scans_immutable BEFORE UPDATE OR DELETE ON patrol_scans FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- A point visited during a patrol: scanned, then done once its checks are saved.
CREATE TABLE patrol_visits (
  company_id          uuid NOT NULL REFERENCES companies(id),
  patrol_id           uuid NOT NULL REFERENCES patrol_instances(id),
  point_id            uuid NOT NULL REFERENCES patrol_points(id),
  scanned_at          timestamptz NOT NULL,
  done_at             timestamptz,
  note                text NOT NULL DEFAULT '',
  photo_key           text,
  photo_content_type  text,
  checks_event_id     uuid UNIQUE,
  PRIMARY KEY (patrol_id, point_id)
);

-- Readings kept as data, so trends can be reported later.
CREATE TABLE patrol_readings (
  id            bigserial PRIMARY KEY,
  company_id    uuid NOT NULL REFERENCES companies(id),
  patrol_id     uuid NOT NULL REFERENCES patrol_instances(id),
  point_id      uuid NOT NULL REFERENCES patrol_points(id),
  check_id      text NOT NULL,
  label         text NOT NULL,
  kind          text NOT NULL,
  value_num     numeric,
  value_ok      boolean,
  unit          text,
  out_of_limit  boolean NOT NULL DEFAULT false,
  report_id     uuid REFERENCES reports(id),
  at            timestamptz NOT NULL
);
CREATE INDEX patrol_readings_point ON patrol_readings (point_id, check_id, at);
CREATE TRIGGER patrol_readings_immutable BEFORE UPDATE OR DELETE ON patrol_readings FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Overdue patrol alerts (section 6.5): raised, acknowledged, escalated, cleared.
CREATE TABLE patrol_alerts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  patrol_id        uuid NOT NULL UNIQUE REFERENCES patrol_instances(id),
  site_id          uuid NOT NULL REFERENCES sites(id),
  employee_id      uuid NOT NULL REFERENCES employees(id),
  raised_at        timestamptz NOT NULL,
  acknowledged_at  timestamptz,
  acknowledged_by  uuid REFERENCES users(id),
  escalated_at     timestamptz,
  cleared_at       timestamptz,
  cleared_by       uuid REFERENCES users(id),
  clear_reason     text
);
CREATE INDEX patrol_alerts_open ON patrol_alerts (site_id) WHERE cleared_at IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['patrol_types','patrol_rules','patrol_points','patrol_instances','patrol_scans','patrol_visits',
                           'patrol_readings','patrol_alerts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id())
                    WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON patrol_types, patrol_points, patrol_instances, patrol_visits, patrol_alerts TO onpar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON patrol_rules TO onpar_app;
GRANT SELECT, INSERT ON patrol_scans, patrol_readings TO onpar_app;
GRANT USAGE ON SEQUENCE patrol_readings_id_seq TO onpar_app;
