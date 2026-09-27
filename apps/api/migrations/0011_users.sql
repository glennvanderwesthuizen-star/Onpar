-- Milestone 10: managing management users from the website.

-- A user given a temporary password (new account or reset) must choose their own at next sign-in.
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN password_changed_at timestamptz;
