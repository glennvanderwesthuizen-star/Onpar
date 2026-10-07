-- Visitor management, step 3 (plan approved 7 Oct 2026): the customer's approval.
-- The customers of the unit are asked in the customer app; if nobody answers in time the guard
-- phones the unit and records how the call went.

ALTER TABLE visits
  -- When the customers were asked, and until when the gate waits before it may phone.
  ADD COLUMN approval_requested_at timestamptz,
  ADD COLUMN respond_by timestamptz,
  -- How many customers were asked in the app (none: the gate may phone at once).
  ADD COLUMN asked integer NOT NULL DEFAULT 0,
  ADD COLUMN decided_at timestamptz;

-- Every answer and every phone call about a visit. Append-only.
CREATE TABLE visit_approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  visit_id     uuid NOT NULL REFERENCES visits(id),
  -- 'push': answered in the customer app. 'phone': the guard phoned and recorded the outcome.
  method       text NOT NULL CHECK (method IN ('push','phone')),
  -- 'no_answer': one call was not answered. 'no_response': the guard gave up and turned the visitor away.
  outcome      text NOT NULL CHECK (outcome IN ('approved','denied','no_answer','no_response')),
  -- Who answered in the app, or whose number was phoned.
  customer_id  uuid REFERENCES customers(id),
  -- For a phone call: the customer's own number, or their second contact.
  contact      text CHECK (contact IN ('primary','second')),
  -- The guard who recorded a phone outcome.
  guard_id     uuid REFERENCES employees(id),
  device_id    uuid REFERENCES devices(id),
  -- Made on the phone, so an outcome sent twice is saved once.
  event_id     uuid,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX visit_approvals_event ON visit_approvals (company_id, event_id) WHERE event_id IS NOT NULL;
CREATE INDEX visit_approvals_visit ON visit_approvals (visit_id, at);
CREATE TRIGGER visit_approvals_immutable BEFORE UPDATE OR DELETE ON visit_approvals FOR EACH ROW EXECUTE FUNCTION forbid_change();

ALTER TABLE visit_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON visit_approvals USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT ON visit_approvals TO onpar_app;
