-- ID badge v2 (owner, 4 Oct 2026). Each guard's card carries a random code (no personal
-- information) in its QR code. A guard has at most one valid card; reissuing a card cancels
-- the old one, which then no longer signs in. Cards are never deleted; the only change
-- allowed is cancelling a card once.
CREATE TABLE employee_badges (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  employee_id    uuid NOT NULL REFERENCES employees(id),
  token          text NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{24}$'),
  issued_at      timestamptz NOT NULL DEFAULT now(),
  issued_by      uuid REFERENCES users(id),
  revoked_at     timestamptz,
  revoked_by     uuid REFERENCES users(id),
  revoke_reason  text,
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE UNIQUE INDEX employee_badges_one_valid ON employee_badges (employee_id) WHERE revoked_at IS NULL;

CREATE FUNCTION employee_badges_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ID cards are never deleted; reissue to cancel one';
  END IF;
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
     AND (to_jsonb(NEW) - 'revoked_at' - 'revoked_by' - 'revoke_reason') = (to_jsonb(OLD) - 'revoked_at' - 'revoked_by' - 'revoke_reason') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'An ID card can only be cancelled, once';
END $$;
CREATE TRIGGER employee_badges_immutable BEFORE UPDATE OR DELETE ON employee_badges
  FOR EACH ROW EXECUTE FUNCTION employee_badges_immutable();

ALTER TABLE employee_badges ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON employee_badges USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON employee_badges TO onpar_app;
