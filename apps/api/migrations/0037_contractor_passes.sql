-- Contractors (owner, 7 Oct 2026). Anyone who arrives unannounced is a visitor. A contractor
-- exists only where a customer has registered one in advance: with his cell number, how many
-- workers may come with him, and a time to be gone by. When he is still on site at that time
-- the customer is asked, automatically, whether he is still busy.

ALTER TABLE visitor_passes
  ADD COLUMN contractor  boolean NOT NULL DEFAULT false,
  -- Workers who may come with the contractor, not counting him. Approved by the customer.
  ADD COLUMN max_workers integer CHECK (max_workers BETWEEN 0 AND 99),
  -- The time of day to be gone by. Null: the site's time for contractors.
  ADD COLUMN leave_by    time,
  ADD CHECK (NOT contractor OR (cell IS NOT NULL AND max_workers IS NOT NULL));

ALTER TABLE visits
  -- The customer said the visitor is still busy: the new time to be gone by.
  ADD COLUMN leave_by      timestamptz,
  -- When the customer was last asked whether a visitor past their time is still busy.
  ADD COLUMN stay_asked_at timestamptz;

-- What a customer answered when asked about a visitor still on site past their time. Append-only.
CREATE TABLE visit_stay_answers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  visit_id    uuid NOT NULL REFERENCES visits(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  -- 'extended': still busy, until `until`. 'should_have_left': the customer expected them gone.
  answer      text NOT NULL CHECK (answer IN ('extended','should_have_left')),
  until       timestamptz,
  at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((answer = 'extended') = (until IS NOT NULL))
);
CREATE INDEX visit_stay_answers_visit ON visit_stay_answers (visit_id, at);
CREATE TRIGGER visit_stay_answers_immutable BEFORE UPDATE OR DELETE ON visit_stay_answers FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE visit_stay_answers ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON visit_stay_answers USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT ON visit_stay_answers TO onpar_app;

-- When the customer gives a later time, the overstay is noted afresh at that time.
GRANT UPDATE (due_at, flagged_at) ON visit_overstays TO onpar_app;
