-- Phase 0 of the optimisation review (9 Oct 2026): signing out, or a password change or reset,
-- ends the account's other open sessions. A sign-in token issued before this moment is refused.
ALTER TABLE users ADD COLUMN sessions_from timestamptz;
ALTER TABLE customers ADD COLUMN sessions_from timestamptz;
ALTER TABLE portal_accounts ADD COLUMN sessions_from timestamptz;
