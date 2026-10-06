-- Alerts raised by real events (plan of 6 Oct 2026, phase 2). An alert is now written in the
-- same database step as the event that caused it (a panic, a Red report), so the two can never
-- disagree, and it is sent to phones straight afterwards. `dispatched_at` marks that sending
-- was attempted; an alert left unsent by a restart is picked up within half a minute.
ALTER TABLE notifications ADD COLUMN dispatched_at timestamptz;
UPDATE notifications SET dispatched_at = created_at;
CREATE INDEX notifications_undispatched ON notifications (company_id, created_at) WHERE dispatched_at IS NULL;
-- One "post uncovered" or similar alert per event and person, however often the check runs.
CREATE INDEX notifications_entity ON notifications (entity_type, entity_id, kind);
