-- Milestone 10: hardening.

-- Sign-in throttling. It happens before anyone is signed in, so there is no
-- company yet: the table holds only hashed keys (never an email address) and
-- the app reaches it only through the functions below.
CREATE TABLE auth_throttle (
  key           text PRIMARY KEY,           -- 'email:<sha256>' or 'ip:<address>'
  failures      integer NOT NULL DEFAULT 0,
  window_start  timestamptz NOT NULL DEFAULT now(),
  locked_until  timestamptz
);
ALTER TABLE auth_throttle ENABLE ROW LEVEL SECURITY;  -- no policy: the app role cannot read it directly

-- When the key is locked, returns the time the lock ends; otherwise null.
CREATE FUNCTION auth_throttle_locked(p_key text) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT locked_until FROM auth_throttle WHERE key = p_key AND locked_until > now()
$$;

-- Counts a failure. After p_max failures within p_window the key is locked for p_lock.
CREATE FUNCTION auth_throttle_fail(p_key text, p_max integer, p_window interval, p_lock interval) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r auth_throttle;
BEGIN
  INSERT INTO auth_throttle AS t (key, failures, window_start) VALUES (p_key, 1, now())
  ON CONFLICT (key) DO UPDATE SET
    failures = CASE WHEN t.window_start < now() - p_window THEN 1 ELSE t.failures + 1 END,
    window_start = CASE WHEN t.window_start < now() - p_window THEN now() ELSE t.window_start END
  RETURNING * INTO r;
  IF r.failures >= p_max THEN
    UPDATE auth_throttle SET locked_until = now() + p_lock, failures = 0, window_start = now() WHERE key = p_key
    RETURNING locked_until INTO r.locked_until;
    RETURN r.locked_until;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION auth_throttle_clear(p_key text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM auth_throttle WHERE key = p_key
$$;

REVOKE ALL ON FUNCTION auth_throttle_locked(text), auth_throttle_fail(text, integer, interval, interval), auth_throttle_clear(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_throttle_locked(text), auth_throttle_fail(text, integer, interval, interval), auth_throttle_clear(text) TO onpar_app;

