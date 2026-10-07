-- PANIC no longer phones the control room by itself (owner, 7 Oct 2026): it sends the alert and
-- opens the emergency panel, where Control room is the first of five buttons. A tap on it is
-- recorded like the others.
ALTER TABLE emergency_calls DROP CONSTRAINT emergency_calls_service_check;
ALTER TABLE emergency_calls ADD CONSTRAINT emergency_calls_service_check
  CHECK (service IN ('control_room','police','fire','ambulance','armed_response'));
