-- Staff of a unit who come in their own vehicle (owner, 7 Oct 2026): registered as on foot or
-- by vehicle, with the number plate.
ALTER TABLE unit_staff
  ADD COLUMN by_vehicle boolean NOT NULL DEFAULT false,
  -- In its compared form. The vehicle they usually come in.
  ADD COLUMN registration text,
  ADD CHECK (NOT by_vehicle OR registration IS NOT NULL);
