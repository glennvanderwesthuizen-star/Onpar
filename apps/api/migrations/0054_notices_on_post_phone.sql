-- The owner, 9 Oct 2026 (D-52): a guard signed in on the post phone with his own PIN may open
-- his own notices there; with two guards on one phone, only the one holding it. On by default;
-- a company can switch it off, and then only the generic line shows (brief section 6.14).
ALTER TABLE hr_settings ADD COLUMN notices_on_post_phone boolean NOT NULL DEFAULT true;
