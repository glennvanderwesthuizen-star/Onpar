-- Alerts to a person's own phone (plan of 6 Oct 2026, decision D-38). One alert service for
-- every app: the supervisor app now, the customer app later. The first channel is the alert
-- system built into phone browsers ("web push"); WhatsApp or SMS can be added as further
-- channels without changing the code that raises alerts.

-- The server's own key pair for sending alerts. One for the whole server, made the first time
-- it is needed; the private half is encrypted by the application with DATA_KEY. The app role
-- reaches it only through the two functions below.
CREATE TABLE push_keys (
  id               boolean PRIMARY KEY DEFAULT true CHECK (id),
  public_key       text NOT NULL,
  private_key_enc  text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE push_keys ENABLE ROW LEVEL SECURITY;  -- no policy: the app role cannot read it directly

CREATE FUNCTION push_keys_get() RETURNS TABLE (public_key text, private_key_enc text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public_key, private_key_enc FROM push_keys
$$;

-- Saves the keys unless some already exist (two servers starting together), and returns the ones kept.
CREATE FUNCTION push_keys_init(p_public text, p_private_enc text) RETURNS TABLE (public_key text, private_key_enc text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO push_keys (public_key, private_key_enc) VALUES (p_public, p_private_enc) ON CONFLICT (id) DO NOTHING;
  RETURN QUERY SELECT k.public_key, k.private_key_enc FROM push_keys k;
END $$;

-- A phone or computer browser a person has allowed alerts on.
CREATE TABLE push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    text NOT NULL,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  label       text NOT NULL DEFAULT 'Device',
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at  timestamptz
);
-- One browser gives one address, so it belongs to one person at a time, across all companies.
CREATE UNIQUE INDEX push_subscriptions_endpoint ON push_subscriptions (endpoint);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);

-- A shared phone: when another person (possibly of another company) allows alerts in the same
-- browser, the address moves to them, so nobody receives the previous person's alerts. Only the
-- browser itself knows both the address and its key.
CREATE FUNCTION push_subscription_release(p_endpoint text, p_p256dh text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM push_subscriptions WHERE endpoint = p_endpoint AND p256dh = p_p256dh
$$;

-- Every alert raised for a person: the alerts list in the app, and the record of what was sent.
CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  title        text NOT NULL,
  body         text NOT NULL DEFAULT '',
  -- What shows on a locked screen: general, never personal details.
  lock_screen  text NOT NULL,
  -- The page it opens, inside On Par.
  url          text NOT NULL DEFAULT '/alerts',
  site_id      uuid REFERENCES sites(id),
  entity_type  text,
  entity_id    uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Seen in the alerts list.
  read_at      timestamptz,
  -- Opened by tapping the alert on the phone.
  opened_at    timestamptz
);
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);

-- What happened when each alert was sent, per channel and device. Append-only.
CREATE TABLE notification_deliveries (
  id               bigserial PRIMARY KEY,
  company_id       uuid NOT NULL REFERENCES companies(id),
  notification_id  uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel          text NOT NULL CHECK (channel IN ('push')),
  -- sent: handed to the delivery service. failed: it refused or could not be reached.
  -- no_device: the person has not allowed alerts on any device.
  status           text NOT NULL CHECK (status IN ('sent','failed','no_device')),
  device_label     text NOT NULL DEFAULT '',
  detail           text NOT NULL DEFAULT '',
  at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_deliveries_notification ON notification_deliveries (notification_id);
CREATE TRIGGER notification_deliveries_no_update BEFORE UPDATE ON notification_deliveries FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Alerts a person has switched off for themselves. No row means on.
CREATE TABLE notification_prefs (
  company_id  uuid NOT NULL REFERENCES companies(id),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  enabled     boolean NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['push_subscriptions','notifications','notification_deliveries','notification_prefs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions, notification_prefs TO onpar_app;
GRANT SELECT, INSERT, UPDATE ON notifications TO onpar_app;
GRANT SELECT, INSERT ON notification_deliveries TO onpar_app;
GRANT USAGE ON SEQUENCE notification_deliveries_id_seq TO onpar_app;
REVOKE ALL ON FUNCTION push_keys_get(), push_keys_init(text, text), push_subscription_release(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION push_keys_get(), push_keys_init(text, text), push_subscription_release(text, text) TO onpar_app;
