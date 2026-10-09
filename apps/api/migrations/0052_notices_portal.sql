-- HR notices with delivery tracking (brief sections 6.14 and 6.16, milestone 13; owner's step 7,
-- 8 Oct 2026) and the employee portal they are delivered to (the guard's own phone or any
-- browser). Personal and disciplinary data: separate tables, HR roles only, never on the post phone.

CREATE TABLE notices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  employee_id  uuid NOT NULL REFERENCES employees(id),
  type         text NOT NULL CHECK (type IN ('verbal_warning','written_warning','severe_written_warning','final_written_warning','end_of_line_memo','notice_to_appear','hearing_outcome','general_message')),
  subject      text NOT NULL,
  body         text NOT NULL,
  details      jsonb NOT NULL DEFAULT '{}',
  -- Performance events HR cites as evidence (never a trigger).
  evidence     jsonb NOT NULL DEFAULT '[]',
  ack_hours    integer NOT NULL CHECK (ack_hours BETWEEN 1 AND 720),
  issued_by    uuid NOT NULL REFERENCES users(id),
  issued_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notices_employee ON notices (employee_id, issued_at DESC);
CREATE TRIGGER notices_immutable BEFORE UPDATE OR DELETE ON notices FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Sent, delivered, opened, acknowledged; hand delivery asked for and done (with the signed copy). Append-only.
CREATE TABLE notice_events (
  id           bigserial PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies(id),
  notice_id    uuid NOT NULL REFERENCES notices(id),
  kind         text NOT NULL CHECK (kind IN ('sent','delivered','opened','acknowledged','hand_delivery_requested','hand_delivered')),
  at           timestamptz NOT NULL DEFAULT now(),
  actor_type   text NOT NULL CHECK (actor_type IN ('user','employee','system')),
  actor_id     uuid,
  actor_label  text NOT NULL DEFAULT '',
  note         text NOT NULL DEFAULT '',
  photo_key    text,
  photo_type   text
);
CREATE INDEX notice_events_notice ON notice_events (notice_id, at);
-- Each of these happens once per notice.
CREATE UNIQUE INDEX notice_events_once ON notice_events (notice_id, kind) WHERE kind IN ('sent','delivered','opened','acknowledged','hand_delivery_requested');
CREATE TRIGGER notice_events_immutable BEFORE UPDATE OR DELETE ON notice_events FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- How long an employee has to acknowledge before HR is asked to deliver by hand.
CREATE TABLE hr_settings (
  company_id         uuid PRIMARY KEY REFERENCES companies(id),
  notice_ack_hours   integer NOT NULL DEFAULT 48 CHECK (notice_ack_hours BETWEEN 1 AND 720),
  updated_by         uuid REFERENCES users(id),
  updated_at         timestamptz
);

-- The employee portal: a personal sign-in, opened with a one-time code from HR (no SMS yet).
CREATE TABLE portal_accounts (
  employee_id        uuid PRIMARY KEY REFERENCES employees(id),
  company_id         uuid NOT NULL REFERENCES companies(id),
  -- The sign-in name, unique across all companies (the TSF number where there is one).
  login              text NOT NULL,
  password_hash      text,
  code_hash          text,
  code_expires_at    timestamptz,
  activated_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX portal_accounts_login ON portal_accounts (lower(login));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notices','notice_events','hr_settings','portal_accounts']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON notices, notice_events TO onpar_app;
GRANT USAGE ON SEQUENCE notice_events_id_seq TO onpar_app;
GRANT SELECT, INSERT, UPDATE ON hr_settings, portal_accounts TO onpar_app;

-- Sign-in happens before the company is known, so these look across companies (like customers').
CREATE FUNCTION auth_portal_by_login(p_login text)
RETURNS TABLE (employee_id uuid, company_id uuid, password_hash text, active boolean, full_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.employee_id, a.company_id, a.password_hash, e.status = 'active', e.full_name
    FROM portal_accounts a JOIN employees e ON e.id = a.employee_id WHERE lower(a.login) = lower(p_login)
$$;
CREATE FUNCTION auth_portal_by_code(p_code_hash text)
RETURNS TABLE (employee_id uuid, company_id uuid, login text, code_expires_at timestamptz, active boolean, full_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.employee_id, a.company_id, a.login, a.code_expires_at, e.status = 'active', e.full_name
    FROM portal_accounts a JOIN employees e ON e.id = a.employee_id WHERE a.code_hash = p_code_hash
$$;
CREATE FUNCTION auth_portal_login_taken(p_login text, p_employee uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM portal_accounts WHERE lower(login) = lower(p_login) AND employee_id <> p_employee)
$$;
REVOKE ALL ON FUNCTION auth_portal_by_login(text), auth_portal_by_code(text), auth_portal_login_taken(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_portal_by_login(text), auth_portal_by_code(text), auth_portal_login_taken(text, uuid) TO onpar_app;

