-- A goal can need a kind of training (owner, 8 Oct 2026): pre-employment training, a
-- SASSETA-accredited course, armed response, an instructor rating and so on.
ALTER TABLE wire_items ADD COLUMN needs_training text;
