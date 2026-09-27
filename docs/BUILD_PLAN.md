# On Par: Build Plan

Prepared from `OnPar_Claude_Code_Build_Brief.md` (v2.1) and `OnPar_Prototype_Reference.html`.
Status: **stack confirmed by the owner (27 Sep 2026). Milestone 1 (foundation) is being built in parallel while the Milestone 0 phone is arranged (decision D-01).**

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

---

## 8. Progress log

### Milestone 1: foundation, built 27 Sep 2026

- Companies, users, roles and permissions, with site-scoped access for supervisors, site managers and clients.
- Sites: create and edit in place with automatic saving (section 30); shift cards colour-coded Day/Night with a guards stepper that never goes below 1 (section 36); equipment per shift; approved contacts; payroll month start day, default 26 (section 41).
- Officer enrolment (section 6.12): four tabs, SA ID check-digit test, ID encrypted at rest and shown masked, all four photos required, qualifications with certificates, issued uniform and kit, grade and firearm warnings that need confirmation and are recorded in the audit log. Viewing photos is logged.
- Devices (section 6.1): register to a site and post (key shown once), assign, lock, disable, retire, heartbeat (battery, app version, kiosk status).
- Guard PIN login on a device, with lockout after five wrong PINs until a supervisor resets it with a reason.
- Audit log: append-only, enforced by the database.
- Tenant separation: PostgreSQL row-level security. The app's database user cannot turn it off.
- Tests: 63 automated tests, covering acceptance scenarios 11 (enrolment) and 14 (tenant separation). They run on GitHub for every change.

**Carried to later milestones, not forgotten:**
- Sites and officers cannot yet be deactivated or have their details edited after enrolment (the prototype also lacks officer editing; see brief section 14).
- Items for Milestone 10 (hardening): move the website sign-in token from browser session storage to a secure cookie; add rate-limiting to management sign-in; use encrypted S3 storage in place of local disk; clean up uploaded files when an enrolment is rolled back; add a platform tool for creating new companies (currently done by the seed script).

### Milestone 2: Duty On, Duty From and attendance, built 27 Sep 2026

- Duty On and Duty From need the PIN again. Pressing Duty On records attendance at once; the declaration (all three statements, selfie, optional comment) follows as its own step, so an unfinished one shows as "declaration pending" (section 6.2).
- Declarations store the exact wording shown and its version. They and the duty events cannot be edited or deleted; the database refuses. A selfie sent after its text (photos sync last when offline) can be attached once.
- Statuses: ON TIME up to 5 minutes after the start (configurable per company), LATE with minutes, EARLY DEPARTURE with minutes, APPROVED EXCEPTION with a supervisor's reason.
- Offline (section 8): every device action carries its own ID, so retries never duplicate. The device sends its trusted time (last server time plus elapsed time); events arriving late are flagged "late-synced", a phone clock over 2 minutes out is flagged, and events over 72 hours old are refused.
- Supervisors can log Duty On or Duty From for an officer, only with a reason, audited. The officer still owes the declaration on the device.
- Management website: an Attendance page per day and site, and a shift page showing both declarations, the comment, and the selfie beside the registration photo (each view logged).
- Tests: acceptance scenarios 1 (attendance part), 10 and 13, plus tenant separation for attendance.

**Interim until rostering (milestone 21), flagged:** the server matches a Duty On to the site shift whose window (from 2 hours before its start to its end) contains the time. There is no roster yet, so **ABSENT cannot be shown** and "declaration pending" only covers people who logged Duty On. When rostering is built, the scheduled shift will come from the roster instead; the attendance records already store the scheduled times, so nothing needs to change in them.

**Carried forward:**
- Comments marked "raise as equipment report" are stored with that flag; milestone 5 (reports) will turn them into reports, and link injury reports to the Duty On declaration.
- Attendance events will feed the scoring engine in milestone 4 (on time +1, late −1).
- The guard device screens themselves are built in Kotlin once milestone 0 settles the phone and MDM. The server side they need is ready and tested.
- The wording "Duty From" is confirmed by the owner (decision D-06).

### Milestone 0 note, 27 Sep 2026

The owner has no Android phone yet, only a personal iPhone. The iPhone cannot run the kiosk and calling tests: those need Android's dedicated-device (lock task) mode and the ability to act as the phone's dialler, which iOS does not allow for apps. What an iPhone *can* check is QR scanning with a GPS accuracy reading at real patrol spots, through a web page in Safari. Milestone 0 proper still needs an Android phone.

### Milestone 3: tasks, built 27 Sep 2026

- A task is for one officer or for a post (whoever is on duty at that post's device). It repeats once, daily, weekly or monthly. A monthly task on the 29th to 31st falls on the last day of shorter months.
- **Untimed by default** (section 25): the guard sees it as "any time during the shift". Only when "a specific time is required" is ticked does it have a due time, after which it shows as overdue.
- The server creates each occurrence on schedule, a week ahead, whether or not earlier ones were done (scenario 9). Anything not done by the end of its day is recorded as missed by the scheduler.
- The guard completes a task (with a photo when required, which may follow later if offline) or reports "could not complete" with a reason. That carries no penalty until a supervisor reviews it: accepted means no penalty; not accepted means it counts as not done (scoring, milestone 4).
- Each occurrence keeps its own copy of the task, history, evidence and reason. Editing a task changes only open occurrences from today on; stopping it cancels later ones.
- A task done before midnight but synced after the day ended still counts, and its history says so.
- Management website: a Tasks page per day and site with counts (done, still to do, overdue, missed, to review), a list of all tasks with edit and stop, a task form, and an occurrence page with history, photo and review.
- Tests: scenarios 1 (generator check with photo) and 9, plus tenant separation.

**Interim, flagged:** a task's day is the calendar day (midnight to midnight). A night shift crosses midnight, so a daily task for night-shift posts may be better tied to the shift than the date. Worth deciding once real tasks are set up; the scheduler can change without affecting stored records.

**Noticed while testing:** a site supervisor can only choose officers registered at their own site, so they cannot assign a task to a relief guard from another site. That is decision D-19 (home site vs working site).

### Milestone 4: scoring engine, built 27 Sep 2026

- One module decides all points (section 6.8). Other parts of the system only report what happened.
- Score = 80 + the points from the last 30 days, each day held within ±5, and the result kept between 0 and 120. Above Par 90+, On Par 70–89, Needs Attention below 70. All of these, and the points per event, are company settings a manager can change; a change affects only events from then on (scenario 15).
- Events so far: on time (+1) and late (−1) from Duty On; task completed (+1); missed task (−1) for tasks assigned to a person; "could not complete" costs nothing unless a supervisor does not accept the reason. Report closed, training completed, missed shift and patrol points are ready in the rules and will start once those milestones exist.
- Events are append-only; the database refuses edits and deletions. A correction is a reversal: an offsetting entry on the same day, with who and why.
- Every lost point shows its evidence (with a link to the attendance or task record) and can be queried by the officer within 7 days from the device. A supervisor answers within 3 working days (South African public holidays are skipped). A supervisor can uphold; only a manager can reverse.
- Supervisors can award up to +2, managers up to +5 at a time. Points can never be taken away by hand.
- When a manager approves an attendance exception, the late point is reversed automatically. When a supervisor approves one, the point stays for a manager to reverse, because every reversal needs a manager.
- Management website: a Scores page (positions, queries to answer), an officer score page (why, award, reverse), and a scoring rules page.
- Tests: scenarios 1 (score part) and 15.

**Flagged:**
- Decision D-21, decided by the owner: when a task assigned to a post is missed, every guard who logged Duty On on that post's device and was on duty that day loses the point. (A Duty On logged by a supervisor on someone's behalf has no device, so it does not count here.)
- Holidays the President declares ad hoc (for example election days) are not in the working-day calculation.
- The guard's own score screen on the phone is part of the Kotlin app; the server side it needs is ready.
- As the brief says, have an employment lawyer review the scoring rules before real use (L-01).

### Milestone 5: reports and close-out, built 27 Sep 2026

- Anyone can report: guards from the post device (photo now or later if offline) and supervisors or managers on the website. Categories and Green/Amber/Red priority as in section 6.6.
- Routing: each report goes to the site supervisor, plus the site manager for Red. A site can set its own routing (stored per site; a settings screen can come later). Company managers see every report.
- Six stages, each recording who, their role, a note and the time in an append-only history: Reported, Assigned (to someone in the new People directory of staff and contractors), Actioned (recorded by the supervisor for contractors), Attendance checked, Job inspected, Closed (company manager only).
- Attendance checked sends an inspection task to the post the report came from. The officer records "Repair done, all OK" (Job inspected) or "Not fixed" (back to Assigned, inspection cancelled) on the report.
- Guard follow-up at any time once assigned, by the reporter or any officer on that site: not started, in progress, repair done, not fixed. It goes into the history and flags the report for the supervisor.
- The reporter gets +1 when the report is closed. The inspection counts as a completed task.
- Comments on a Duty On/From declaration marked "raise as equipment report" now become Equipment reports (Green). An injury report shows what the officer declared at Duty On for that shift.
- Section 24 is included now: each open report holds its own colour badge, freed when it closes, and the priority shows as a flat traffic light.
- Management website: Reports list with counts ("reported, resolved, outstanding"), a report page with the stage bar, history, photos and next-step actions, a New report form and the People directory.
- Tests: scenarios 1 (report part), 8, 10 (injury link) and 16.

**Flagged:**
- Declaration equipment reports: the guard picks the priority when raising it, like any report (owner, 27 Sep 2026); Green if none is chosen.
- Contractors do not have their own login yet (decision D-10); the supervisor records their work.
- Reports raised automatically from failed patrol checks arrive with milestone 6.

### Milestone 6: patrols, built 27 Sep 2026

- Patrol types per site (for example A internal, B perimeter, C guard-room check-in as a single scan), each with its own three rules **per shift**, so day and night can differ: patrols per shift (the shift split into equal windows), minimum gap, maximum duration. The setup page warns when the gap plus the duration cannot fit a window.
- Patrol points with a printable QR code each (Print QR codes on the setup page), a location and radius (30 m default; "use my current location" when standing at the point), a special instruction, photo and note (off, optional or required), and checks: a number with a unit and limit, OK/Problem, or a photo.
- A scan counts only with a GPS fix of 25 m or better within the point's radius. Rejected scans (too far, poor GPS, unknown code, not open yet) are logged and shown to supervisors. Repeat scans within 2 minutes are ignored. Location is captured only at a scan.
- The first accepted scan starts the patrol and its clock. Points may be scanned in any order. A point counts once its required photo, note and readings are saved. A reading outside its limit, or Problem, raises an Amber report automatically. Readings are stored as data for trends later.
- Only one patrol at a time; one per window; the next of a type waits for the minimum gap (the device is told when the next one opens).
- Overdue alert when a patrol passes its maximum duration; escalated to the control room if nobody acknowledges within 10 minutes; cleared when the patrol completes or a supervisor confirms the guard is safe. The server checks every minute.
- A guard who cannot finish gives a reason: "ended early", no penalty until a supervisor reviews it (not accepted counts as a missed patrol).
- Patrol points: each shift's allocation is shared across all its required patrols with cumulative rounding, so completing all of them earns exactly the allocation. Windows with no patrol are recorded as missed patrols (0 points by default, a company setting).
- Management website: Patrols page (live alerts, compliance per type, the day's patrols, rejected scans), patrol detail (every scan, points, readings, photos, the alert's history, review), and Patrol setup.
- Tests: scenarios 2, 3, 4, 5, 6 and 7.

**Flagged:**
- Push notifications and the SMS to the control room need the notification service (Firebase and an SMS provider, section 4), not yet connected. Until then alerts show on the website, refreshed every 30 seconds, with the officer's and control room's numbers to call.
- The phone's own countdown and local alarm when there is no signal are part of the Kotlin app (Milestone 0 onwards).
- Importing codes from your current QR product (decision D-08) is still open; tell me the product name when you can.
- The MDM must block mock-location apps and developer options (Milestone 0).
