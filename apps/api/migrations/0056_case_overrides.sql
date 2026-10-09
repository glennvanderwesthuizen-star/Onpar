-- The owner, 9 Oct 2026 (D-53): when a disciplinary inquiry goes against the usual practice (a
-- representative who is not an employee, or fewer warnings than the set number), the manager is
-- warned and may go ahead with a reason. Each override is kept with the case.
ALTER TABLE disciplinary_cases ADD COLUMN overrides jsonb NOT NULL DEFAULT '[]';
