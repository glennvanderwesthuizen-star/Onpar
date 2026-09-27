-- Milestone 10: indexes found by the load test. Days are looked up as a time
-- range (South African midnight to midnight), which these indexes serve.
CREATE INDEX patrol_instances_site_window ON patrol_instances (site_id, window_start);
CREATE INDEX patrol_instances_employee_window ON patrol_instances (employee_id, window_start);
CREATE INDEX reports_site_reported ON reports (site_id, reported_at);
CREATE INDEX reports_reporter ON reports (reported_by_employee, reported_at);
CREATE INDEX patrol_scans_official ON patrol_scans (official_at);
CREATE INDEX report_history_actor ON report_history (actor_id, at) WHERE actor_type = 'employee';
