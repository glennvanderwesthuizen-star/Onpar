# On Par: Build Plan

Prepared from `OnPar_Claude_Code_Build_Brief.md` (v2.1) and `OnPar_Prototype_Reference.html`.
Status: **draft, waiting for the owner to confirm the technology stack (section 3) and the decisions in `OPEN_DECISIONS.md`.** No application code has been written yet, as the brief requires.

---

## 1. What we are building, in one paragraph

On Par has three parts that talk to one central server:

1. **The guard device app.** An Android app on a company-issued rugged phone, locked so the guard can only use On Par (kiosk mode). Used for Duty On/Duty From, tasks, patrols (QR + GPS), reports, re-orders, calls to approved contacts and his own score. It must keep working without signal and catch up later.
2. **The management website.** Used by supervisors, managers, HR and admins in a normal web browser. Dashboard, setup of sites and officers, report close-out, rostering, the Electronic Occurrence Book (EOB), reports.
3. **The employee portal (Phase 2).** A website the guard opens on his own phone for personal matters (queries, notices, his roster). Nothing to install.

Behind them sits **one server (the API) and one database**, hosted in South Africa, where every record belongs to one company and one company can never see another's data.

---

## 2. How we will work

- Small steps. After each step you get a plain-language summary of what changed and how to see it.
- Every rule in the brief's acceptance scenarios (sections 12, 35 and 43, 33 scenarios in total) becomes an automated test, written **as each milestone is built**, not at the end.
- Anything legal (labour law, POPIA, firearms, PSIRA) is built as a **setting you can change** and flagged to you. I will not decide those points.
- Nothing personal, no passwords and no keys go into the GitHub repository.
- All times are server time in Africa/Johannesburg.
- Work happens on branches and reaches the main branch through pull requests you can review.

---

## 3. Recommended technology (please confirm)

| Part | Recommendation | Why, in plain terms |
|---|---|---|
| Guard device app | **Native Android, written in Kotlin** | Kiosk lock, the phone dialler, camera, QR scanning and GPS all need full control of the phone. Cross-platform tools (Flutter, React Native) would need native add-ons for exactly these hard parts, so they save little here. Matches the brief. |
| Server (API) | **NestJS (TypeScript)** | The brief allows NestJS or Django. Choosing NestJS means the server, the management website and the portal all use **one language (TypeScript)**, so there is one set of skills to hire for and code can be shared, for example the scoring rules and the roster calculation. |
| Database | **PostgreSQL**, with row-level security switched on from day one | Industry standard. Row-level security makes the database itself refuse to return another company's rows, as a second lock behind the app's own checks. |
| Management website | **Next.js (React)** | Matches the brief. |
| Employee portal | **Same Next.js project**, separate login and pages | One codebase to maintain. Personal and HR data stays behind its own roles. |
| Hosting | **AWS Cape Town (af-south-1)** | Keeps data in South Africa (POPIA). Azure South Africa North is an equally valid choice; AWS has slightly wider service coverage in its SA region. |
| Photos and certificates | AWS S3 (Cape Town), encrypted | Standard file storage. |
| Notifications | Firebase push, plus an SMS provider (for example Clickatell or BulkSMS, both South African) | Matches the brief. |
| Phone management (MDM) | **Decided in Milestone 0.** Trial **Hexnode** or **Scalefusion** first; Google's **Android Management API** as the fallback | The commercial tools give you a ready-made admin console. Google's API is free but needs us to build the console ourselves. See section 5. |

Repository layout once coding starts (one repository, several parts):

```
apps/
  api/          server (NestJS)
  web/          management website + employee portal (Next.js)
  android/      guard device app (Kotlin)
packages/
  rules/        shared business rules: scoring, patrol points, roster, payroll period
docs/           brief, prototype, this plan, decisions
```

The **`packages/rules`** part is deliberate: the brief's trickiest logic (score calculation, patrol-point sharing with exact rounding, roster positions, the Night-into-Day check, payroll periods) will be written once, tested heavily, and used by both the server and the website. The Android app mirrors the few rules it needs offline (patrol timers, the duplicate-scan window) with its own tests.

---

## 4. Milestones, in order

Numbered as in the brief (sections 11 and 34). The order follows the brief exactly.

### Stage A: prove the hardware (do first, highest risk)

| # | Milestone | You will be able to see |
|---|---|---|
| **0** | **Hardware spike** | A real rugged phone that boots straight into a test On Par app with no way out, calls only approved numbers, answers and ends an incoming call without escaping, and scans a QR code with a GPS lock. Plus a fixed estimate for the rest. |

### Stage B: the MVP

| # | Milestone | You will be able to see |
|---|---|---|
| 1 | Foundation | Log in to the management website; create a company, sites, users and roles; register a device; enrol an officer. Audit log working. Proof that company A cannot see company B. |
| 2 | Duty On / Duty From and attendance | Guard logs Duty On with PIN, selfie and the three declarations; statuses ON TIME / LATE etc.; works offline and syncs. |
| 3 | Tasks | Assign tasks (untimed by default, section 25); recurrence generated by the server on schedule; "could not complete" with reason. |
| 4 | Scoring engine | Score, positions, "why my score changed", query button, reversals, daily cap. |
| 5 | Reports and close-out | All six stages, routing, people directory, inspection task, guard follow-up, colour badges (section 24). |
| 6 | Patrols | Patrol types and rules, QR + GPS lock, point checks and readings, overdue alerts with escalation, patrol points. |
| 7 | Re-orders and kit | Issued items, personal and site re-orders, all stages, receipt. |
| 8 | Qualifications and training | Expiry tracking and compliance figures. |
| 9 | Management dashboard | All figures and the drill-down from company to event. |
| 10 | Hardening | Security review, backup and restore test, POPIA checklist, load test. |
| 11 | **Pilot** | One site, real guards, real phones. |

### Stage C: after the MVP is solid

| # | Milestone |
|---|---|
| 12 | Employee portal and queries |
| 13 | Notices (HR), with delivery tracking and hand-delivery fallback |
| 14 | Franchise model (TSF above franchisees) |
| 15 | Report colour badges and untimed tasks *(these two are small; I propose folding them into milestones 3 and 5 so they are not built twice; see decision D-15)* |
| 16 | Gamification (private to the guard) |
| 17 | Electronic Occurrence Book |
| 18 | HR templates and suggested actions |
| 19 | Firearm allocation and return (armed sites) |
| 20 | Site editing *(proposed to fold into milestone 1; see D-15)* |
| 21 | Shift patterns and rostering |
| 22 | Reports module: attendance register, on the site's payroll month (section 41) |

---

## 5. Milestone 0 in detail: the hardware spike

This is the one milestone that needs **you** to do physical things, because I cannot hold a phone. Everything else can be built and tested in the cloud.

**What you need to get:**
1. **One rugged Android phone** (the Blackview test model is fine), with a SIM card that can make voice calls, and ideally a second ordinary phone to call it from.
2. **A free trial account** with one MDM, Hexnode or Scalefusion (both offer free trials). I will give you step-by-step instructions when you are ready.
3. **A few printed QR codes** (I will generate them) placed at known spots outside.

**What I will build for it:** a small, throwaway test Android app (not the real app) that:
- runs in Android "dedicated device" (lock task) mode,
- acts as the phone's dialler, showing only a list of approved contacts with no keypad, and handles incoming calls with Answer / Decline without leaving kiosk mode,
- scans a QR code and accepts it only with a GPS fix of 25 m or better within 30 m of the point.

**The main technical risk, stated plainly:** for calls to work inside kiosk mode, the On Par app must become the phone's **default phone app** (Android allows an app to take over that role). Some rugged-phone manufacturers modify Android's calling screens, so this must be proven on the actual phone model before anything else is built. If it fails on the Blackview, we learn that now and choose a different model, not after months of work.

**How you will test it:** I will give you a one-page checklist (boot the phone, try to escape, call the supervisor number, receive a call, scan a code from 480 m away and from the right spot). You tick each line and tell me the results.

**Done when:** every line of the checklist passes, the MDM is chosen, and I give you a fixed estimate for the rest of the build.

---

## 6. Things I found in the brief that need tidying

These are not problems with your idea, just small inconsistencies worth knowing about. Where the brief and prototype disagree, **the brief wins** (the brief says so itself) unless you say otherwise.

1. **Sections 16 to 23 are missing from the brief.** The brief jumps from section 15 to section 24. The missing material (portal, notices, franchise, gamification, EOB, rostering) exists in the brief's sections 6.14 to 6.17 and in the prototype's "Spec addendum" tab, so nothing is lost, but some cross-references in the brief point at section numbers from the prototype rather than the brief. Example: "site marked armed (section 15)" means the brief's section 6.13. I will treat the prototype's numbering as the meaning of those references.
2. **Registration photos: two or four?** The prototype's spec tab (its section 12) says two photos. The brief (section 6.12) says four: face, full body, ID document and PSIRA card. **I will build four.**
3. **Roster formula.** The prototype's spec tab says "(position plus days elapsed) modulo length". The brief says `(position − 1 + days since start) modulo length`. The brief's version is the correct one (it makes position 1 mean day one of the cycle). **I will use the brief's formula.**
4. **Recurring tasks.** The prototype creates the next task only when the current one is done. The brief says the server must create each one on schedule regardless. **I will follow the brief.**
5. **Task time.** Section 6.4 says every task has a time; section 25 later makes time optional and off by default. **Section 25 wins.**
6. **Supervisor name-matching.** Section 30 notes that employees are linked to sites by name in the prototype. **The real build links everything by a permanent ID**, so renaming a site breaks nothing.
7. **Night-into-Day check.** Section 31 notes it assumes 06:00/18:00 shifts. **I will build it to compare each site's real shift times from the start**, since doing it properly costs little extra.

---

## 7. What I need from you now

1. **Confirm or change the technology in section 3.**
2. Read `OPEN_DECISIONS.md`. Only the items marked **"needed before Milestone 0/1"** are urgent. The rest can wait until their milestone.
3. When convenient, get the phone, SIM and MDM trial for Milestone 0.

While you arrange the phone, I can start **Milestone 1 (foundation)** in parallel, because it does not depend on the phone. That goes slightly against the brief's strict order ("do not start application screens before Milestone 0 is proven"). The brief's worry is wasted effort if the phone plan fails, but the server, database and website are needed whatever phone is chosen, so the risk is low. **Your call; see decision D-01.**
