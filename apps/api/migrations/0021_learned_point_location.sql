-- Patrol points can be set up without a location (owner, 4 Oct 2026). On Par learns it from
-- the first 10 scans that agree within 30 m; until then scans are accepted without a
-- distance check (the GPS accuracy rule still applies).
ALTER TABLE patrol_points
  ALTER COLUMN lat DROP NOT NULL,
  ALTER COLUMN lng DROP NOT NULL,
  ADD COLUMN location_source text CHECK (location_source IN ('manual','learned')),
  ADD COLUMN location_set_at timestamptz;
UPDATE patrol_points SET location_source = 'manual' WHERE lat IS NOT NULL;
ALTER TABLE patrol_points ADD CONSTRAINT patrol_points_location_pair CHECK ((lat IS NULL) = (lng IS NULL));
