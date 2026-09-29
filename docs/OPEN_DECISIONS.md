# On Par: Open Decisions

Every decision the brief says belongs to the owner, plus a few found while planning.
Each has a recommendation, but **none is decided until the owner says so.** Update the "Decision" column as answers come in.

Legend for "Needed by": **M0** = before the hardware spike, **M1** = before the foundation, **Mx** = before that milestone, **Legal** = needs a specialist, not just the owner.

## Needed soon

| ID | Question | Recommendation | Needed by | Decision |
|---|---|---|---|---|
| D-01 | Start the foundation (server, database, website) while the phone spike is being arranged, or wait strictly for the spike to pass? | Start in parallel. None of that work depends on the phone model. | M0 | **Decided 27 Sep 2026: start in parallel.** |
| D-02 | Technology stack (see `BUILD_PLAN.md` section 3). | Kotlin Android app; NestJS server; Next.js website and portal; PostgreSQL; AWS Cape Town. | M1 | **Decided 27 Sep 2026: recommended stack.** |
| D-03 | Which MDM (phone management system)? | Trial Hexnode or Scalefusion first; Android Management API as fallback. Settled by the spike. | M0 | *open* |
| D-04 | Which rugged phone model to standardise on? | Test with the Blackview you have; settled by the spike. | M0 | *open* |
| D-05 | Hosting: AWS Cape Town or Azure South Africa North? | AWS Cape Town. | M1 | *open* |
| D-06 | Is "Duty From" the intended term, or "Duty Off"? | Keep "Duty From" as supplied, but it is stored as a label, so changing it later is trivial. | M2 | **Decided 27 Sep 2026: "Duty From" is correct.** |

## Needed later (by milestone)

| ID | Question | Recommendation | Needed by | Decision |
|---|---|---|---|---|
| D-07 | Should patrol types be weighted differently when sharing patrol points? | Equal shares for now (as the brief says); weighting can be added later without changing stored data. | M6 | *open* |
| D-08 | Can the existing QR product export its codes, so they can be imported as patrol points? | Find out the product name; if it exports CSV, I will build an import. | M6 | **Decided 27 Sep 2026: there is no existing QR system. On Par makes and prints its own codes (weatherproof stickers or engraved plates recommended).** |
| D-09 | Re-orders: does "Assigned" mean assigned to a person to deliver? | Yes (the brief's assumption). | M7 | *open* |
| D-10 | When do contractors get their own login? | After the pilot. | After M11 | *open* |
| D-11 | When is a management mode added inside the device app? | After the pilot. | After M11 | *open* |
| D-12 | Client logo slot (for example Standard Bank): permission and the logo file. | TSF obtains written permission first; until then the slot shows nothing. | M11 | *open* |
| D-13 | Employee portal login: employee number + PIN + SMS code? Who pays for data on personal phones? | Yes to the login; data cost is a business decision. | M12 | *open* |
| D-14 | Acknowledgement period before a notice is flagged for hand delivery. | Configurable; suggest 48 hours in real use (the prototype's 60 minutes is for demos). | M13 | *open* |
| D-15 | Fold the small v2.0 items (report colours, untimed tasks, site editing) into the MVP milestones they belong to, rather than building them later as separate milestones? | Yes. It avoids building those screens twice. | M1 | *open* |
| D-16 | Who acts as HR in a small franchisee? | Allow one person to hold several roles (for example owner + HR). | M13 | *open* |
| D-17 | What TSF may see across franchisees. | Aggregates only, as in the brief, until agreed in writing. | M14 | *open* |
| D-18 | How franchisees are charged (per guard, per device, flat fee). | Business decision; does not affect the build until billing is wanted. | M14 | *open* |
| D-19 | Separate an employee's "home site" from their "currently rostered site" (for relief cover)? | Yes, build them as two separate fields from the start; it is cheap now and expensive later. | M21 | **Decided 28 Sep 2026: yes. Every guard has a home site, and guards often also work a second site, either regularly or ad hoc.** How this fits the brief's "one active allocation per person" rule (section 38) is D-25. |
| D-20 | Different guard requirements on weekends and public holidays? | Build the data model to allow it (per day-of-week plus holiday override), show it simply at first. | M21 | **Decided 28 Sep 2026: yes, the guards needed are set for each day on its own.** Exactly how this is entered is part of D-25. |
| D-21 | A missed task assigned to a **post** (not a person): who loses the point? Several guards may have worked that post that day. | Until decided, nobody loses a point for it; it still shows as missed on the Tasks page. Options: every guard who did Duty On at that post that day, or only the guard on duty at the task's due time. | M4 | **Decided 27 Sep 2026: every guard who logged Duty On at that post and was on duty that day loses the point, because the task showed on each of their screens.** |
| D-22 | When does an open report count as **overdue** on the dashboard? The brief sets no deadline. | Proposed: open longer than 1 day (Red), 3 days (Amber) or 7 days (Green). Built with these defaults; they can become a company setting. | M9 | **Decided 27 Sep 2026: keep 1 day (Red), 3 days (Amber), 7 days (Green).** |
| D-23 | What does a **client or estate manager** see on the dashboard? The brief says "read-only summary for their site". | Built: attendance, tasks, reports, patrols and re-orders figures for their site only; no names, scores, training or devices, and no drill-down to officers. | M9 | *open*: the owner will decide later; the interim summary stays until then. |
| D-25 | Rostering details from the owner's description of 28 Sep 2026: how a second site is rostered (regular and ad hoc); how "each day on its own" is entered; whether a Night-into-Day clash can ever be overridden. | One pattern at the home site; other sites by per-day changes (once, or repeating weekly); guards needed per weekday plus a public-holiday figure, with single-date changes; Night-into-Day always blocked; build rostering now, before the pilot. | M21 | **Decided 29 Sep 2026: all four recommendations accepted.** |
| D-24 | POPIA actions before the pilot: Information Officer, operator agreements, retention periods, employee notice, photo advice, impact assessment, breach procedure, who holds the keys. | Listed as P-1 to P-9 in docs/POPIA_CHECKLIST.md, with a draft notice and breach procedure. Photo removal is built but stays off until P-3 is confirmed. | M10/M11 | *open* |

## Needs a specialist (the brief says: flag, never decide)

| ID | Topic | Who to ask | What the build does meanwhile |
|---|---|---|---|
| L-01 | Scoring rules and their use in performance conversations | Employment lawyer | Scores never trigger anything automatically; all rules configurable. |
| L-02 | Duty On/From declaration wording and injury-on-duty claims | Employment lawyer | Wording stored with a version number; editable. |
| L-03 | Warning and notice templates, the warning ladder, whether an app notice is valid notice, bargaining council rules | Labour lawyer | Templates are drafts; hand-delivery fallback built in. |
| L-04 | Photos, selfies and ID copies under POPIA; retention periods; Information Officer; operator agreement | POPIA specialist | Photos encrypted and access-restricted; retention periods configurable. |
| L-05 | Firearm register, custody, allocation and return | Firearms compliance specialist | Quantity only, plus the allocation/return workflow in section 29, flagged as not a legal register. |
| L-06 | PSIRA verification | PSIRA / compliance | Manual check recorded by a manager; no integration. |
| L-07 | Weekly working hours under the BCEA (roster patterns could exceed limits) | Labour lawyer | Proposed: a configurable weekly-hours warning once the limit is confirmed. |
| L-08 | Cost recovery for replaced uniform or kit | Labour lawyer | No deductions built, ever, until advised. |
