# On Par: guidance for Claude Code

On Par is a performance-management and operational-accountability platform for private security companies, built for The Security Franchise (TSF).

## Sources of truth (read before working)

1. `docs/OnPar_Claude_Code_Build_Brief.md`: the spec. Where it conflicts with anything else, it wins.
2. `docs/OnPar_Prototype_Reference.html`: a clickable prototype. Use it for exact interaction details when the brief is ambiguous. It is a behavioural reference, **not code to reuse** (see brief section 14 for what it simplifies).
3. `docs/BUILD_PLAN.md`: the agreed plan, stack and milestone order, including known brief/prototype inconsistencies and how they are resolved.
4. `docs/OPEN_DECISIONS.md`: owner decisions. Do not assume an answer to an item marked *open*; ask.

## The owner

The owner is not a developer. Explain in plain language, work in small steps, show progress often, and ask when a decision is needed instead of assuming.

## Hard rules (from the brief)

- Build milestones in the order in `docs/BUILD_PLAN.md`.
- Write the brief's acceptance scenarios (sections 12, 35, 43) as automated tests while building each milestone.
- Always test: the scoring engine, patrol rules, recurrence, offline sync and tenant separation.
- Every record carries a company ID; PostgreSQL row-level security is on from day one.
- Performance events, declarations, report and re-order history, notices and firearm records are append-only or immutable. Reversals add offsetting events; nothing is deleted.
- Scores never trigger discipline, deductions or warnings automatically. HR "suggested actions" only pre-fill a form.
- No hardware-brand-specific logic in the core app. The requirement is "managed Android device".
- Location is captured only at the moment of a scan (and the optional Duty On site check), never continuously.
- Personal, pay and disciplinary data sits in separate tables with its own roles and audit trail, and is never shown on the shared post device.
- Time is server time in Africa/Johannesburg.
- Never commit secrets or personal data. Use migration scripts for all database changes.
- Do not build anything on the brief's excluded list (section 3).
- Legal, labour-law, POPIA, firearms and PSIRA points: build the configurable mechanism and flag the question to the owner. Never decide them.
- Relationships are keyed by stable IDs, never by names.
