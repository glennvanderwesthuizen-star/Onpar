-- Lock or roam (owner, 7 Oct 2026): a guard can be locked to one position of a site (a post
-- phone, for example "Main gate") or left to roam. A locked guard is the primary on his
-- position's phone while he is on duty there. No row: the guard roams.
CREATE TABLE guard_postings (
  company_id  uuid NOT NULL REFERENCES companies(id),
  site_id     uuid NOT NULL REFERENCES sites(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  -- The post phone of the position he is locked to.
  device_id   uuid NOT NULL REFERENCES devices(id),
  set_by      uuid NOT NULL REFERENCES users(id),
  set_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, employee_id)
);
ALTER TABLE guard_postings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON guard_postings USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON guard_postings TO onpar_app;
