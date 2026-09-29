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

### Rostering: the owner's process (28 Sep 2026, for Milestones 21 and 22)

In the owner's words, summarised. It matches brief sections 31 and 36 to 43, with two additions (a second site, and each day set on its own).

1. **Payroll month: 26th to 25th.** This leaves four days to collect the attendance registers and process pay (brief section 41, default 26).
2. **Allocate = site + shift pattern + person.** The allocation also has a position, which sets where in the pattern the guard starts, so we know which day or night shift he begins on (brief section 31).
3. **No day shift straight after a night shift** (brief section 31, checked against each site's real shift times).
4. **Home site plus a second site.** Every guard has a home site. Many also work a second site, either regularly or ad hoc (D-19). The brief (section 38) allows only one allocation per person, so how a second site is rostered is open (D-25).
5. **Guards needed are set for each day on its own** (D-20). How this is entered is open (D-25).
6. **Attendance fills itself in.** Duty On and Duty From on the phone fill in the guard's actual attendance against his roster, which becomes the attendance register used for pay (brief section 32; not a payslip).
7. **The guard sees his own roster.** After he signs in with his PIN, the phone shows only the days he is working (brief section 40).

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
- Decision D-08: there is no existing QR product; On Par's own printed codes are used.
- The MDM must block mock-location apps and developer options (Milestone 0).

### Milestone 7: re-orders and issued kit, built 27 Sep 2026

- Each company has its own kit list (a Kit list page; uniform tracked by size, equipment by asset number). Enrolment now uses it, and supervisors can issue kit to an officer later from the officer's page, which sets the issue date.
- On the device, Re-order is part of the Report function: **Personal** (pick from the items issued to you; the size or asset number is filled in from your profile; the comment gives the reason) or **Site** (free text, for example "Toilet paper, 2 packs").
- Stages: Requested, Ordered, Assigned (to a person to deliver it, the brief's assumption for decision D-09), Delivered, Received. Each records who, their role, a note and the time in an append-only history. The guard confirms Received on the device; for a personal item its issue date then updates.
- No deductions of any kind (labour-law question, L-08); the re-order page says so.
- Management website: Re-orders list with counts, a re-order page with the stage bar, history and next step, and the Kit list page.
- Tests: scenario 12.

**Later, as the brief says:** approval limits, stock levels, supplier orders and cost tracking.

### Milestone 8: qualifications and training, built 27 Sep 2026

- Qualifications per officer: firearm competency, first aid, fire fighting and other, each with a completion date, an expiry date and a certificate (PDF or photo). A renewal is recorded as a new record; the old one stays as history and the latest one counts.
- Status: Compliant, Expiring (within 30 days) or Expired. PSIRA registration is shown alongside and can be updated by a manager (number, grade, expiry and a reason), with an audit trail.
- Training page on the website: compliant percentage, expiring, expired and items tracked, with tabs (Needs attention, Expired, Expiring, All) and a site filter. The officer's page shows current qualifications first, history greyed out, and forms to record a qualification or renewal and to update PSIRA.
- Recording completed training earns +1 on the officer's score, once per record. Corrections to a record are audited with before and after.
- Officers can see their own qualifications on the device.
- Supervisors can view; only company managers, HR and system admins can record.
- The website header is now two rows (logo and user on top, menu below) so the growing menu stays tidy.
- Tests: qualification status and renewals, the +1 point, date checks, corrections, PSIRA updates, the device view and company separation (scenario 14).

**Flagged:**
- The 30-day "expiring" window is a fixed default for now; it is written to become a company setting.
- PSIRA registration is checked by hand against PSIRA's records. An automatic PSIRA check is not built (no official interface is known; a question for the owner).
- Reminder messages before expiry need the notification service (section 4), not yet connected.

### Milestone 9: management dashboard, built 27 Sep 2026

- The Overview page is now the dashboard, for any day (today refreshes every minute). Figures from section 6.11: attendance (scheduled, on time, late, absent), tasks (completed, outstanding, overdue, missed, could not complete), reports (open, action required, overdue), patrols (alerts open, compliance overall and per type), re-orders open, training (compliant %, expiring, expired), performance (needs attention) and devices (active, not seen for an hour). Live patrol alerts show at the top. Each group links to its own page.
- A "By site" table, then the drill-down: **Company → Site → Officer → Event**. The site page shows each officer's day (shift, tasks, patrols, reports, training, score), duty declarations with selfies and comments, checkpoint readings, rejected scans and devices. The officer page shows the shift and declarations, tasks (including the post's tasks shared by everyone on duty), patrols, reports and follow-ups, training and the day's performance events; every item opens its own record.
- What each role sees follows their permissions: supervisors only their sites; a client or estate manager gets the summary figures only (decision D-23); HR sees training.
- Tests: every figure checked against a day of known activity, site scoping, the client summary, company separation (scenario 14).

**Flagged:**
- **Absent** is interim until rostering (milestone 21): a post counts as absent when nobody logged Duty On for it once the shift has started (plus the grace period). With rostering it will name the missing person.
- **Report overdue** uses proposed deadlines, decision D-22.

### Milestone 10: hardening, built 27 Sep 2026

- **Security review and fixes:**
  - Website sign-in now uses a secure cookie that page scripts cannot read.
  - Changes must come from the On Par website itself.
  - Sign-in locks for 15 minutes after 5 wrong passwords (or 30 from one address).
  - Security headers on the website and server.
  - Uploads are checked against their real content.
  - Every stored photo and certificate is encrypted.
  - Optional S3 storage in Cape Town.
  - Files are cleaned up when an enrolment fails.
  - The dependency audit is clean.
  - Automated tests prove row-level security is on for every table and cannot be bypassed.
- **Users:** a Users page for the system administrator (add, change role and sites, deactivate, reset password). New and reset accounts get a temporary password that must be replaced at first sign-in (12+ characters). There is also My account and a command to create a new company with its first administrator.
- **Backups:** encrypted backup and restore scripts. An automated test backs up, restores into an empty database and proves the copy works, with companies still separated and the audit log still locked.
- **POPIA:**
  - Photo retention (selfies and patrol photos, proposed 12 months), **off until switched on**. Each day it removes only the image, never the record, and logs every removal (Privacy page).
  - docs/POPIA_CHECKLIST.md with a draft employee notice and breach procedure.
  - docs/OPERATIONS.md for running it.
- **Load test:** one year of data for 60 sites and 500 officers. Zero errors. About 40 times headroom over pilot traffic after fixing a slow dashboard query (docs/LOAD_TEST.md).

**Flagged:**
- POPIA actions for the owner and legal, P-1 to P-9 (decision D-24). Photo removal stays off until the retention periods are confirmed.
- Changing `DATA_KEY` (the file and ID encryption key) needs a re-encryption run, which is not built yet.
- The S3 storage option is tested against a stand-in, not a real bucket. Check it once the AWS account exists.
- Run one server for the pilot; move the scheduled jobs to a single worker before running more.

### Guard phone app, stages 1 and 2, built 27 Sep 2026

- `apps/android`, in Kotlin.
  - **Core logic:** the connection to the server, the offline outbox, trusted time, setup, sign-in, duty and declarations. It is plain Kotlin, so it is tested here, including against a running On Par server.
  - **Android screens:** built on GitHub, which keeps the installable app file for 30 days with each build.
- **Setup:** a supervisor registers the phone on the Devices page, which now shows a setup QR code; the phone scans it. The details can also be typed in.
- **Guard login:** employee number and PIN (five wrong PINs lock it, as before).
- **Home:** shows the shift status (on time or late, since when) with **Duty On** / **Duty From** (PIN again).
- **Check-in:** every minute the phone checks in (battery, app version), sends anything waiting and refreshes.
- **Offline:** every action waits on the phone in the order it happened, survives a restart, is never duplicated when retried, and a refusal is kept with its reason.
- **Declarations:** owed straight after Duty On or Duty From, even with no signal. Every statement must be ticked and a selfie taken. An optional comment can be raised as an equipment report. The text goes first, the photo after.
- QR codes are read with ZXing, which works on any Android phone without Google services.

**Stage 3, tasks (27 Sep 2026):**
- **Today's list:** the guard's own tasks and the post's tasks, kept on the phone for when there is no signal and cleared at log-out. Untimed tasks show as "any time during the shift"; timed ones show as due or overdue.
- **Done:** with a photo when the task needs one, plus an optional comment. The photo is sent after the task.
- **Could not complete:** the guard gives a reason (and an explanation for "Other"). There is no penalty until a supervisor reviews it.
- **Offline and refusals:** a task done offline shows as "waiting to send". A refusal (for example, not on duty yet) shows the server's reason.
- **Inspection tasks** point to the report, where they will be recorded in stage 5.

**Stage 4, patrols (27 Sep 2026):**
- **Patrols screen:** each patrol type with how many are done and whether it is ready or when it opens. The patrol in progress shows its points and a countdown that runs on the phone, with an alarm (tone and vibration) when it runs over, even with no signal.
- **Scanning:** the QR code, then one GPS reading taken at that moment only, waiting for 25 m accuracy. Fake-GPS readings are refused.
  - The first accepted scan starts the patrol, and points can be scanned in any order.
  - A point of another patrol is refused while one is in progress.
- **Checks at each point:** the special instruction, photo and note (off, optional or required), numbers with limits (the phone warns when out of limit), OK/Problem and photo checks. The server raises the report automatically.
- **No signal:** scans and checks wait on the phone and are validated when sent. The phone recognises points from a fingerprint of their QR code; the codes themselves never leave the server, so they cannot be copied from a phone.
- **Ending early:** a patrol can be ended early with a reason.
- **Tests:** scenarios 4, 5 and 7 were run from the phone logic against the real server.

**Stage 5, reports and re-orders (27 Sep 2026):**
- **New report:** category, priority (Red warns that it also goes to the site manager), what was seen, and an optional photo sent with it.
- **Reports list:** the guard's own reports and the site's open reports, with the colour badge, stage and assignee.
- **Follow-up:** not started, in progress, repair done and OK, or not fixed (which needs a note), with an optional photo.
  - The phone applies the server's rules first: no follow-up before the report is assigned or after it is closed.
  - An inspection task in the Tasks list opens its report to record "Repair done, all OK" or "Not fixed".
- **Re-orders:**
  - Personal: pick from the items issued to you; the size or asset number comes from your profile.
  - Site: free text and quantity.
  - The list shows each re-order's stage, with "I have received it" once it is on its way.
- **No signal:** reports and re-orders made with no signal show as "waiting for signal to send".
- **Tests:** scenarios 1, 8 and 12 were run from the phone logic against the real server.

**Stage 6, score, training, calls and kiosk (27 Sep 2026):**
- **My score:** the score and position, why it changed (each event with its evidence), and **Query this** on lost points within the query window, showing the answer or when it is due. The fairness note is shown.
- **My training:** qualifications and PSIRA registration, marked current, expiring soon or expired.
- **Call:** approved contacts for the site only (supervisor, site manager, control room), with no keypad.
  - Available from the home screen, the declaration screen and the login screen (so the control room can be called before anyone logs in).
  - The list is kept on the phone, because calls use the mobile network and work without data.
  - New server endpoint: `GET /device/contacts` (device key only).
- **Calls inside On Par:** On Par can become the phone's calling app (Android's dialer role). Every call, incoming or outgoing, is then shown inside On Par with Answer, Decline and End, so the guard never leaves kiosk mode.
- **Kiosk:**
  - When the phone-management system allows it, On Par locks itself to the screen (Android lock task mode) and becomes the home screen.
  - On an unmanaged test phone nothing is locked.
  - The phone reports "locked", "allowed" or "not managed" with each check-in, shown on the Devices page.
  - Nothing is specific to a phone brand.

**All six stages are built.** What remains is the hardware test (Milestone 0) on a real phone with a phone-management system: kiosk lock, calls inside On Par, QR and GPS on the actual device.

**Flagged:**
- A guard's sign-in lasts 16 hours on the phone. Actions made offline and sent more than 16 hours later would be refused. Before the pilot, decide whether queued actions should carry a longer-lived device-level permission (the server already refuses anything over 72 hours old).
- `dl.google.com` is blocked in this build environment, so the Android screens are only built on GitHub. Allowing it (environment network settings) would let them be built and checked here too.
