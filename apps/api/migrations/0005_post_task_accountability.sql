-- Decision D-21 (owner, 27 Sep 2026): a missed task assigned to a post costs a point
-- for every guard who logged Duty On at that post that day. One source can now give
-- the same kind of event to several officers, so the once-only rule is per officer.

DROP INDEX performance_events_once;
CREATE UNIQUE INDEX performance_events_once ON performance_events (source_type, source_id, event_type, employee_id)
  WHERE source_id IS NOT NULL AND reverses_event_id IS NULL AND source_type <> 'manual';
