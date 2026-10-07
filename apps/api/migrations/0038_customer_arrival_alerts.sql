-- A customer may switch off "your visitor has arrived" for themselves (owner, 7 Oct 2026):
-- it is for information only. Requests that need an answer are always sent.
ALTER TABLE customers ADD COLUMN mute_arrival_alerts boolean NOT NULL DEFAULT false;
