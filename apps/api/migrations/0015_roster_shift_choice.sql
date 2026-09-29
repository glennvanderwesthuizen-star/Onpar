-- Milestone 21: which of a site's shifts a pattern's D and N mean, when the site has
-- more than one shift of a kind (for example two night posts). NULL means the first one.
ALTER TABLE roster_allocations
  ADD COLUMN day_shift_id uuid REFERENCES site_shifts(id) ON DELETE SET NULL,
  ADD COLUMN night_shift_id uuid REFERENCES site_shifts(id) ON DELETE SET NULL;
