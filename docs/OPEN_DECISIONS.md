# On Par: Open Decisions

Every decision the brief says belongs to the owner, plus a few found while planning.
Each has a recommendation, but **none is decided until the owner says so.** Update the "Decision" column as answers come in.

Legend for "Needed by": **M0** = before the hardware spike, **M1** = before the foundation, **Mx** = before that milestone, **Legal** = needs a specialist, not just the owner.

## Needed soon

| ID | Question | Recommendation | Needed by | Decision |
|---|---|---|---|---|
| D-01 | Start the foundation (server, database, website) while the phone spike is being arranged, or wait strictly for the spike to pass? | Start in parallel. None of that work depends on the phone model. | M0 | *open* |
| D-02 | Technology stack (see `BUILD_PLAN.md` section 3). | Kotlin Android app; NestJS server; Next.js website and portal; PostgreSQL; AWS Cape Town. | M1 | *open* |
| D-03 | Which MDM (phone management system)? | Trial Hexnode or Scalefusion first; Android Management API as fallback. Settled by the spike. | M0 | *open* |
| D-04 | Which rugged phone model to standardise on? | Test with the Blackview you have; settled by the spike. | M0 | *open* |
| D-05 | Hosting: AWS Cape Town or Azure South Africa North? | AWS Cape Town. | M1 | *open* |
| D-06 | Is "Duty From" the intended term, or "Duty Off"? | Keep "Duty From" as supplied, but it is stored as a label, so changing it later is trivial. | M2 | *open* |

## Needed later (by milestone)

| ID | Question | Recommendation | Needed by | Decision |
|---|---|---|---|---|
| D-07 | Should patrol types be weighted differently when sharing patrol points? | Equal shares for now (as the brief says); weighting can be added later without changing stored data. | M6 | *open* |
| D-08 | Can the existing QR product export its codes, so they can be imported as patrol points? | Find out the product name; if it exports CSV, I will build an import. | M6 | *open* |
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
| D-19 | Separate an employee's "home site" from their "currently rostered site" (for relief cover)? | Yes, build them as two separate fields from the start; it is cheap now and expensive later. | M21 | *open* |
| D-20 | Different guard requirements on weekends and public holidays? | Build the data model to allow it (per day-of-week plus holiday override), show it simply at first. | M21 | *open* |

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
