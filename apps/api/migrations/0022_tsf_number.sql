-- TSF number (owner, 4 Oct 2026): every guard gets a username styled on SA number plates,
-- e.g. BCD123GP, ending in the province of their home site when it is issued. It is held in
-- the QR code on the guard's ID card; the PIN is still typed every time. Sites now carry a
-- province. Existing guards get their number once their site's province is set.
ALTER TABLE sites
  ADD COLUMN province text CHECK (province IN ('GP','WC','KZN','EC','FS','LP','MP','NW','NC'));

ALTER TABLE employees
  ADD COLUMN tsf_number text CHECK (tsf_number ~ '^[BCDFGHJKLMNPRSTVWXYZ]{3}[0-9]{3}(GP|WC|KZN|EC|FS|LP|MP|NW|NC)$'),
  ADD COLUMN tsf_number_issued_at timestamptz,
  ADD CONSTRAINT employees_tsf_number_unique UNIQUE (company_id, tsf_number);

-- Once issued, a TSF number never changes or goes away (records and printed cards rely on it).
CREATE FUNCTION employees_tsf_number_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tsf_number IS NOT NULL AND NEW.tsf_number IS DISTINCT FROM OLD.tsf_number THEN
    RAISE EXCEPTION 'A TSF number cannot be changed once issued';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employees_tsf_number_fixed BEFORE UPDATE OF tsf_number ON employees
  FOR EACH ROW EXECUTE FUNCTION employees_tsf_number_fixed();
