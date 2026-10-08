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

## 7a. Going commercial (parked until after the pilot)

Agreed with the owner on 1 Oct 2026 as the direction. **Nothing here is started yet.**

**How it is sold:** On Par is not a paid app in the Play Store. It is a monthly subscription for security companies. Each company gets its own login and its own separate data (already built). The phone app is free to install and works only for a paying company.

**Order:**
1. **TSF pilot (about 1 to 3 months):**
   - Before it starts: reset the server with new keys, and do the hardware test with the rugged phones and the phone-management system (Milestone 0).
   - Then run On Par for real on a few sites.
2. **Business and legal (owner, with specialists):**
   - Who owns and sells On Par (D-29).
   - A customer agreement drafted by a lawyer (D-30).
   - A POPIA operator agreement with each customer (D-24, D-30).
   - Answers to the legal points already flagged (L-01 to L-08).
3. **Price (D-18):** per guard, per device or per site, and how much.
4. **Build for selling (developer):**
   - Billing: count guards and devices per company each month, and invoice or take payment through a South African payment provider (D-31).
   - A page to add a new customer company, with guided setup.
   - A proper web address (D-32).
   - The release phone app, signed with a private key and published through Google Play or the phone-management system.
   - Monitoring and alerts, and a support channel.
   - A stronger server setup once there are several customers: a managed database with automatic backups, and possibly a second server.
5. **Sell:**
   - A demo company (already there).
   - A one-page brochure and a price list.
   - First customers: TSF franchisees.

Suggested timing: steps 2 to 4 run alongside the pilot, so the first paying franchisee can start when the pilot ends.

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

### Milestones 21 and 22: rostering and the attendance register, built 29 Sep 2026

Built before the pilot at the owner's request (D-25), following the owner's process (section 2 above) and brief sections 31, 32 and 36 to 43.

- **Shift patterns** (Roster → Shift patterns): a repeating cycle of Day, Night and Off, built by tapping + Day, + Night, + Off, with a two-digit number.
  - A night shift straight into a day shift is refused, including when the cycle starts again.
  - A pattern works at any site: D means the site's day shift, N its night shift. If a site has two of a kind (two night posts), the allocation says which.
- **Allocate** (Roster page): site + pattern + guard + start date + position.
  - A guard has only one allocation at a time. Allocating somewhere else moves them, after a warning.
  - A clash check names anyone found on two sites anyway (the brief's second safety net).
  - Grade and firearm competency are checked, with a warning that does not block; the reason is recorded.
- **The roster table**, one week at a time, has three parts:
  - guards needed per shift and day;
  - each guard's worked-out shift for every day;
  - rostered against needed, marked OK, short or over.
- **Day changes** (click any cell), with the pattern left unchanged. A guard can:
  - get a day off;
  - work another shift at this site;
  - work at a second site, **once or every week on that day** (D-19).
  - Relief guards with no pattern can be added for single days.
  - **A day shift straight after a night shift is always blocked** (D-25), checked against each site's real shift times.
- **Guards needed, day by day** (site page): the same every day, or Monday to Sunday plus public holidays (D-20). Any single date can also differ.
  - South African public holidays are worked out automatically, including the Monday after a Sunday holiday. Extra days, such as election days, can be added.
- **Attendance uses the roster.**
  - Duty On is matched to the shift the guard is rostered on, so lateness is measured against the real shift.
  - A guard working at a site where they are not rostered is recorded but not scored.
  - Guards with no roster yet keep the old matching.
  - The dashboard's "Absent" now means a rostered guard who did not arrive. Sites with nobody rostered keep the old count.
- **Attendance register** (Register page): per site, for the payroll month (26th to 25th, or the site's own day), with previous and next month.
  - For each guard and day: the rostered shift, the real Duty On and Duty From, hours worked, and a status. The statuses are complete, on duty, absent, rest day, worked but not on the roster, no record, and still to come.
  - Missing times are shown as missing, never filled in.
  - A day worked at another site counts on that site's register.
  - It can be downloaded for payroll (CSV). It is not a payslip.
- **Phone:**
  - The home screen shows today's real shift, "Off today" or "Not yet rostered", and the next few working days.
  - **My roster** lists the working days of the next four weeks, kept for when there is no signal.
- **Tests:** acceptance scenarios 22 to 26 and 29 to 32 are automated. The totals are 125 rules tests, 234 server tests and 51 phone tests.

**Flagged for the owner:**
- The rest rule only forbids a night shift straight into a day shift, plus any overlap. Weekly working-hours limits under the BCEA (L-07) are not checked yet; this needs a labour lawyer's figure first.
- Swap requests between guards, and leave, are not built. For now, leave is recorded as a day off with a note.

### 1 Oct 2026: front screen, Panic and BOLO (decisions D-27, D-28)

- **Phone front screen** (before sign-in): four big buttons. They are Sign in / Duty On, PANIC, BOLO and Call. PANIC, BOLO and Call work without signing in. PANIC and BOLO are also at the top of the guard's home screen.
- **PANIC:**
  - It must be held for 2 seconds; letting go early cancels it.
  - The phone calls the site's control room at once.
  - It takes one location reading (8 seconds at most), then sends the alert. With no signal, the alert waits at the front of the queue on the phone.
  - The guard is recorded if one is signed in.
- **Website:**
  - A red banner shows on every page while a panic is open. It flashes until someone acknowledges it.
  - The **Panic** page shows where, when and who, whether the call started, and a map link. A supervisor acknowledges, then resolves with a note. Nothing is deleted.
- **BOLO:** a photo plus a short note from the phone, shown under **Reports → BOLO**.
- **Fixed on the way:** the phone app never asked for location permission. On a phone without MDM, a patrol scan could have stopped the app. It now asks, and never reads the location without permission.
- **Tests:** 14 new server tests (248 in total) and 8 new phone tests. One existing live phone test (patrols) fails in the last half hour before a shift change; that is the test's timing, not the app.

**Flagged for the owner:**
- The panic location is an exception to "location only at a scan". It is recorded in the POPIA notice (P-4) for the POPIA specialist to check.
- Live video streaming is planned after the pilot.
- BOLO without sign-in was assumed; say if only signed-in guards should send them.

### 3 Oct 2026: Round A of the owner's testing changes (D-33, docs/NEXT_ROUND.md)

- **Lock instead of Log out while on duty.**
  - The only way off duty is Duty From.
  - Several guards can be signed in on one post phone. The front screen lists those on duty, and each unlocks with his own PIN, even without signal.
- **Relief at shift change.**
  - Duty From waits until a relief has done Duty On: one for one, first in first out.
  - A guard whose turn it is can "let my partner go first" with his PIN; it is recorded.
  - After 30 minutes with no relief, Duty From unlocks and the post shows as uncovered.
  - A supervisor's "Duty From on behalf" releases a guard at any time.
- **Points:** Duty On more than 15 minutes early earns +1. Staying past the shift for a late or missing relief earns +1, plus the points the late guard lost.
- **Overtime minutes:** the register and its download show minutes before and after the rostered shift, and how each guard left.
- **Duty On declaration version 2** adds the relief statement. Phones not yet updated still work and are recorded as version 1.
- **Photos** are turned upright on the phone before they are kept.
- **Tests:** 9 new rules tests, 8 new server tests and 5 new phone tests. The totals are 135 rules, 256 server and 66 phone tests, all passing.

**Flagged for the owner:**
- L-02: the declaration wording.
- L-07: keeping a guard past his shift, and how overtime is paid.
- The "post uncovered" status is shown on the attendance register; a push alert to the supervisor's own phone comes with the supervisor app (D-11).

### 3 Oct 2026: Round B, uniform (D-33, docs/NEXT_ROUND.md items 9 and 10)

- **Catalogue:** uniform items with types (Shirt: short sleeve, long sleeve, golf ...), sizes, prices and a renewal period (12 months by default). There is also a uniform list per site.
- **Guard orders on the post phone ("My uniform"):** a table of his items with the last issue date, his size, how many he may have and when each is next due. He ticks several items and sends one order; items not yet due need a reason.
- **Manager or administrator decides each line:** company account, guard's account, or not issued (with a reason). Prices and totals are shown.
- **Stores clerk (new role):** marks the order ready.
- **Supervisor ("My deliveries"):** collects it and stores confirms the hand-over. The task shows when each guard is next on duty, from the roster.
- **Guard signs for it with his PIN.** For guard's-account items he also signs "I agree to pay R___"; this is a record for payroll, and the app never deducts (L-08). Each issue restarts the item's 12 months.
- **Starter issues** for new guards can be recorded by a manager (Uniform → Guards).
- **Uniform condition notes:** an HR record written by supervisors and read only by managers and HR. Every view is logged, notes are never shown on the post phone, and they never trigger anything by themselves.
- **Not built (owner, 3 Oct):** stock-holding and a separate stores app (later); merchandise (later).
- **Tests:** totals are 139 rules, 266 server and 70 phone tests, all passing.

### 3 Oct 2026: Round C, BOLO (docs/NEXT_ROUND.md item 12)

- **Phone:** pressing BOLO opens big buttons for PHOTO, VIDEO (up to 30 seconds), VOICE NOTE (press and hold) and WRITE, with the PANIC button underneath. Several can go in one BOLO; each shows a tick once added. A BOLO waits on the phone when there is no signal.
- **Website:** an orange BOLO banner (red stays for panic) shows until someone has seen it. The BOLO page plays the video and voice note; managers and supervisors mark "I have seen it", then close the BOLO with what was done.
- **Points:** only at a manager's or supervisor's discretion ("Award points", once per BOLO, within the usual limits). Never automatic, so guards are not tempted to send BOLOs for points.
- **POPIA:** BOLO photos, videos and voice notes follow the company's retention switch. 90 days is proposed and set on the Privacy page; P-3 and P-5 are to be confirmed by the POPIA specialist.

### TSF number and ID card sign-in (D-34), built 4 Oct 2026

- **Sites** now have a province (Gauteng, Western Cape, KwaZulu-Natal and so on). It is required when a site is saved.
- **Every guard gets a TSF number** like `BCD 123 GP` at enrolment, from his home site's province. Guards enrolled before this get theirs as soon as their site's province is set. A number never changes once issued (the database refuses it), even if the guard moves to another province.
- **Website:** the number shows as a number plate (dark blue on white, TSF shield in the middle) on the Officers list and each officer's page. **Print ID cards** makes credit-card-size cards, 10 to an A4 page, with only the logo, the QR code and the guard's name.
- **Phone:** Log in now opens the camera: the guard scans his ID card, sees his plate, then types his PIN. "No card? Type your TSF number" is the fallback. The employee number still works for older app versions.
- The PIN is still checked by the server every time, and five wrong PINs still lock the login. The card on its own is not enough to sign in.

### ID badge v2 (D-35), built 4 Oct 2026

- **The badge:** landscape, credit-card size: TSF logo on the left, the guard's face photo (from enrolment) in the middle with only his full name beneath, and the QR code on the right. White and silver, black edging, TSF red stripe.
- **The QR code** holds only a random card code inside a link, with no name or number. At the post phone the guard scans it, then types his PIN. A supervisor who scans it with any phone camera is asked to sign in first; then the guard's record opens, only if the supervisor may see that guard. Every scan is in the audit log.
- **Lost or damaged card:** "Reissue" on the officer's page cancels the old card at once (it no longer signs in, and scanning it shows "Cancelled card") and issues a new one. Cards are never deleted.
- **Printing:** Officers, then Print ID badges: either 10 on an A4 page for your own printer, or one per page with crop marks for a print shop (save as PDF from the print window).

### Selfie checks, face recognition stage 1 (D-36), built 4 Oct 2026

- **Attendance, then Selfie checks:** each Duty On and Duty From selfie next to the guard's enrolment photo, with **Looks right**, **Unclear** and **Not him** and an optional note. Tabs: To check (last 7 days), Weekly spot check (10 at random), Not him or unclear (last 90 days), Checked.
- The same buttons are on each shift's attendance page, which shows the latest check.
- Checks are never changed or deleted; a second look adds a new check and the latest counts. Every check and every photo view is in the audit log.
- "Not him" is a flag for a manager to look into. It does not change the guard's score, lock his login or start anything else.
- Who checks: supervisors, managers and system administrators. Site managers can see the results.

### Automatic face matching and the blink check, face recognition stage 2 (D-36), built 4 Oct 2026

- **The switch:** Privacy page, "Automatic face matching". Off until someone switches it on, with a reason (audited).
- **At enrolment:** the face photo is compared with the ID document and the PSIRA card. The result shows on the officer's page.
- **At every Duty On and Duty From:** the selfie is compared with the enrolment photo. "Possibly a different person" and "Uncertain" go to the Flagged tab of Selfie checks for a person to look at; once a person has checked it, it leaves the list.
- **How:** open-source face software (face-api, MIT licence; TensorFlow.js, Apache 2.0) on On Par's own server. No photo or face data is sent anywhere. Only the result is kept (how alike, and a verdict), never a face template. About half a second per photo; about 430 MB of memory, only once switched on. Tested with public-domain photos (same person 0.24 to 0.29 apart, different people 0.67; the cut-off is 0.6).
- **Blink check on the phone:** before the Duty On / Duty From selfie the guard looks at the camera and blinks; a printed photo or a still picture cannot. The face finder (Google ML Kit, bundled with the app) runs on the phone. If it cannot pass after 20 seconds (too dark, faulty camera), he can take the selfie anyway; it is marked and flagged for a person. It never stops him working.
- A result is always a flag for a person, never a decision: no score change, no lock, no warning.
- **Still to do:** a trial on TSF's own guards to see how accurate it is on them (lighting at night, darker skin tones), before relying on it.

### 6 Oct 2026: new build order (D-38, D-39, D-40) and phase 1, alerts to a phone

**The order from here:** phase 1 push alerts; phase 2 the supervisor app (a phone layout of this website, with alerts); phase 3 the customer foundation (units, tenants, tenant sign-in); then visitor management. Each phase stops for the owner's approval.

**Phase 1, built 6 Oct 2026:**
- **One alert service** on the server, shared by every app. An alert is first written to the person's alerts list, then sent to each device they set up, so nothing is lost when a phone is off.
- **How alerts travel:** the alert system built into phone and computer browsers. No Firebase and no outside contract. The server makes its own key pair the first time it is needed and keeps the private half encrypted in the database, so an existing server needs no new settings: `deploy/onpar.sh update` is enough.
- **My account** has a new "Alerts on this device" card: Allow alerts on this device, Send me a test alert, Turn off on this device, a list of the person's devices (a lost phone can be removed), and which alerts they receive.
- **Alerts page** (new, in the menu with an unread count): every alert raised for the person, newest first.
- **Lock screen:** an alert carries only a general line ("Panic at Estate ABC"). Details show inside On Par after sign-in.
- **Home screen:** On Par can now be added to a phone's home screen and opens like an app. On an iPhone this is required before alerts work (iOS 16.4 or newer); the card explains the steps.
- **Safety:** the server only sends to the real delivery services (Google, Apple, Mozilla, Microsoft). On a shared phone the alerts move to whoever allowed them last. A device that stops accepting alerts is forgotten automatically.
- **Record:** every alert, each delivery attempt (sent, failed, no device) and whether the alert was seen or opened is kept. Switching a device on or off, a test alert and a change of settings go to the audit log.
- **Alerts a person can switch off:** all except Panic (D-41, open).
- Tests: 12 new server tests (keys, switching on and off, the general line, seen and opened, each person and each company kept apart, settings, shared phone, a device that is gone) and 4 for the shared rules.

**Proven on Android, 6 Oct 2026:** the owner allowed alerts in Chrome on an Android phone, locked it, and sent a test alert from a computer signed in as the same person; the alert arrived on the locked phone. **Proven on an iPhone 14, 6 Oct 2026:** after adding On Par to the home screen, the owner received test alerts there too.

**Not in phase 1:** no real event raises an alert yet. Panic, BOLO, patrol overdue, post uncovered and Red report are connected in phase 2.

**Flagged:**
- The web address (D-32): alerts and the home-screen icon are tied to it. Changing it later means every person allows alerts again.
- `pnpm audit --prod` shows two findings that were there before this work (inside Next.js and TensorFlow.js), none from the new alert library.
- The alert library `web-push` is open source under the MPL 2.0 licence, which allows this use.


### 6 Oct 2026: phase 2, step 2a, the supervisor app: real alerts and the phone screens

**Real alerts now reach phones.** Each goes to the people responsible for that site: supervisors and site managers linked to it, and the managers and administrators who see the whole company. Clients, HR, payroll and stores are never alerted.

| Alert | When it is raised | Opens |
|---|---|---|
| Panic | A guard holds PANIC on the post phone | The panic on the phone screen |
| BOLO | A guard sends a BOLO | The BOLO page |
| Patrol overdue | A started patrol runs past its time (checked every minute) | Open alerts |
| Post uncovered | A guard's relief has not arrived 30 minutes after his shift (checked every minute, alerted once) | Guards on duty |
| Red report | A report with Red priority is made, by a guard, a manager, a patrol check or a declaration | The report |

- The locked screen shows only the kind and the site ("Panic at Estate ABC"). The post and the guard's name show inside On Par.
- An alert is written in the same database step as the event, so there is never an alert without its event or the reverse, and it is sent to phones a moment later. An alert left unsent by a restart goes out within half a minute. Overlapping checks never send it twice.
- Panic cannot be switched off by a person; the other four can (D-41).

**The phone screens** are at `/m` on the same address, with the same sign-in, and open from the home-screen icon. On a small screen the full website shows an "Open the phone view" bar at the top.
- **Home:** any open panic in red at the top, how many other things need attention, then each of the supervisor's sites with who is on duty (late, waiting for relief, no relief) and a button to call the control room.
- **Alerts:** everything open across the supervisor's sites, most urgent first, with the action for each: open the panic, acknowledge a BOLO, acknowledge a patrol alert or confirm the guard is safe (with how), call the guard.
- **Panic:** site, post, guard, time, whether the phone's call to the control room started, the location taken at that moment (opens in Maps; a fake-location warning when the phone reported one), Call guard, Call control room, Acknowledge, and Resolve with what happened.
- **On duty:** every guard on duty per site, with Call and **Release from duty** (a reason is required; it logs Duty From under the supervisor's name).
- The screens refresh every 15 seconds and when the phone returns to On Par. With no connection they keep showing the last update and say so.
- Every action uses the same server rules as the website, so permissions, site limits and the audit trail are identical.
- Tests: 13 new server tests (who is alerted and who is not, the locked-screen wording, once only, another site, another company, switched-off alerts, uncovered posts, patrol overdue, release with a reason, the panic screen's data, roles that are refused). The screens were checked in an iPhone-sized browser in light and dark, including acknowledging and resolving a panic and releasing a guard.

**Proven 6 Oct 2026:** the owner pressed PANIC and the alert arrived on both of his phones (iPhone and Samsung), with the flashing panic banner on screen; the phone screens opened as designed.

**Next (step 2b):** My tasks, reports, selfie checks and attendance on the phone.

### 6 Oct 2026: phase 2, step 2b, the supervisor's daily work on the phone

The bottom tabs are now Home, Alerts, On duty, **My tasks** and **More**.
- **My tasks:** what is waiting on the supervisor himself.
  - Reports waiting on him (not yet assigned, or an officer has followed up) and selfies to check, each with a count.
  - Tasks a guard marked "could not complete", from today and yesterday: accept the reason or not, with a required note. Not accepting costs the guard the points, exactly as on the website, and the screen says so.
  - Uniform: orders to collect at stores ("I have collected these") and orders he holds, with when each guard is next on duty. The guard still signs for them with his PIN on the post phone.
- **Reports:** open reports at his sites, all or only those waiting on him. A report opens in the phone frame with the same steps as the website: assign, record the work, confirm attendance, close, add a note.
- **A photo with a report step** (new, on the phone and the website): for example the finished repair. On a phone it opens the camera.
- **Selfie checks:** the unchecked selfies of the last seven days, one card each: open the photos side by side, then Looks right, Unclear or Not him.
- **Attendance:** today's register for his sites, to read at a glance. Corrections stay on the full website.
- **More:** these pages, all alerts sent to him, My account, the full website and Sign out.
- A Red report alert now opens the report in the phone frame.
- No new server rules: every action uses the website's existing ones. Checked in an iPhone-sized browser.

**Raised by the owner, not built (D-42):** a supervisor is also an employee, with his own shifts, Duty On and Duty From, and his own uniform orders. Decided the same day: own phone, no location, no wait-for-relief, points apply, a manager approves his uniform. This is step 2c.


### 7 Oct 2026: phase 2, step 2c, a supervisor is also an employee (D-42)

- **Joining the two records:** on the Users page, a supervisor's or site manager's sign-in can be joined to his own officer record ("Their own officer record"). One officer record belongs to one sign-in only. He must be enrolled as an officer first, which gives him his TSF number and PIN.
- **Me** (in the supervisor app, from Home and from More):
  - **My shift:** today's shift from the roster, and whether he is on duty.
  - **Duty On and Duty From on his own phone:** his PIN each time, then the declaration and a selfie, as for guards. No location is taken. It is logged at the site he is rostered at that day, else his home site.
  - **No waiting for a relief:** he logs Duty From whenever he leaves. His shift is left out when a guard's relief is worked out, so he neither relieves a guard nor holds one up.
  - **Points apply** as for any employee: on time, late, early departure. He sees his score and why it changed.
  - **My training** and **Coming up** (his next shifts).
  - **My uniform:** what he is entitled to, ordering, and signing for a delivery with his PIN. A manager decides the order; nobody can decide his own.
- **Declaration wording:** he is shown the Duty On wording without the wait-for-relief statement (version 1), since that rule does not apply to him. Whether the other statements (the OB, equipment handed over) suit a supervisor is for the owner and the labour lawyer (L-02).
- **Who can do this:** supervisors and site managers only. Guards keep to the post phone. Other roles are refused even if joined.
- **How:** the guard's own pages on the server now accept either a post phone or a joined supervisor's sign-in, so there is one set of rules, not two. Post-phone-only pages (tasks, patrols, reports from the post, re-orders) stay closed to the supervisor's sign-in.
- **Needs signal:** unlike the post phone, the supervisor app does not queue actions without signal. Duty On from his own phone needs a connection.
- Tests: 12 new server tests. The Me screen was walked through in an iPhone-sized browser: wrong PIN, Duty On, declaration with selfie, Duty From, score and training. **Not seen on screen:** My uniform, because the demo data has no site uniform list; its server rules are the guard's existing ones.
- **No blink check:** the post phone's blink check before the selfie is not available in a web app, so a supervisor's selfie is taken without it. Selfie checks by a person, and automatic matching when switched on, still apply.

**Proven 7 Oct 2026:** the owner tested steps 2b and 2c on his iPhone, signed in as a supervisor joined to his own officer record, and saw his own shift. An iPhone fault found on the way and fixed: the page zoomed in after typing in the sign-in box and cut off the right edge; typing boxes are now large enough that iPhones do not zoom. **Phase 2 is complete.** Next in the plan is phase 3, the customer foundation.


### 7 Oct 2026: phase 3, the customer foundation (D-39)

- **Units and customers.** A site now has units (a house, flat, office or shop) and customers. A customer is either the **client** who hires the security company or a **tenant** in a unit. Both use the same customer app.
- **Set up by the administrator only**, on the site's own page, in a new section "Units, client and tenants": add units, add a person, edit, deactivate, give a new password, and **add many tenants from a spreadsheet** (paste the rows or choose a CSV file; all or nothing, with each problem listed by row). Company managers can look; nobody else sees it.
- **Sign-in:** email and password, on the same sign-in page as staff. Each customer gets a 16-character temporary password, shown once, and must choose their own at first sign-in. One email address signs in to one account only, across staff, customers and every company. Customers stay signed in for 30 days on their own phone.
- **Kept apart from staff.** Customers are a separate kind of account. A customer's sign-in opens only the customer app; every staff page refuses it (tested against eleven of them).
- **The customer app** is at `/c` on the same address:
  - **Home:** the site and unit, how the gate reaches them, whether alerts are on for this phone, and a "Visitors: coming soon" card.
  - **Alerts:** every alert sent to them.
  - **My account:** alerts on this phone with a test alert, their own phone number and a second contact (kept current by the customer; every change is in the audit log under their name), password, sign out.
- **Alerts for customers:** the alert service of phase 1 now sends to customers as well as staff, on the same terms: written to their alerts list, then sent to each phone they switched alerts on for. Deactivating a customer stops their sign-in and their alerts at once.
- **One home-screen icon for everyone:** the icon now opens a start page that sends a supervisor to the phone view, other staff to the website, a customer to the customer app, and anyone not signed in to the sign-in page.
- Tests: 12 new server tests. The whole journey was run in a browser: the administrator adds a unit, a tenant and an import on a computer; the tenant signs in on an iPhone-sized screen, chooses a password, changes the second contact, and the administrator sees it.

**Proven 7 Oct 2026:** the owner added a tenant, signed in as that tenant on his phone, chose a password and received a test alert in the customer app.

**Next:** the visitor management plan (D-40) was sent to the owner for approval on 7 Oct 2026, with eight questions. Nothing is built until he approves it.

**Flagged (POPIA, P-3 and P-5):** tenants' names, email addresses and phone numbers are new personal information about people who are not employees. Before real tenants are loaded: a notice telling tenants what is kept and why, and a retention period for tenants who leave. Neither is built; deactivating a tenant keeps the record.

**Not in this phase:** anything about visitors. Approving and refusing a visitor, announcing who is coming and at which gate, come with visitor management (D-40), which builds on this.

### 7 Oct 2026: visitor management, step 1 of 7, the groundwork (D-40)

The owner approved the visitor management plan and its eight questions on 7 Oct 2026 (answers in D-40).

- **On the site's page**, a new section "Visitors", changed only by the administrator; company managers can look; nobody else sees it.
- **Gates:** add, rename, retire. Names are unique within a site.
- **Checks at the gate:** the spec's eleven checks as switches, on the spec's starting positions. Three cannot be switched on because nothing is behind them yet: stolen vehicle lookup, cell number PIN, documents. The server refuses them too.
- **Waiting times:** seconds to answer an alert (120), minutes before an overstay goes to the supervisor (30), months records are kept (12, a proposal for legal), and whether the second contact may be dialled.
- **Visitor categories:** the five standard ones, created the first time a site is opened, each with its own limit (4 hours; no limit; until 17:00). The administrator can change them and add more.
- **Barred list:** an ID number, cell number or number plate, barred from the whole site or from one unit, always with a reason. Compared in one form however it is typed ("ca 123-456" is "CA123456"). Taking an entry off needs a reason and keeps the record. Each entry has a review date one year on.
- A site that has never saved settings uses the defaults in the rules package (`packages/rules/src/visitors.ts`). Every change is in the audit trail with before and after.
- Migration `0030_visitor_groundwork.sql`: `site_gates`, `site_visitor_settings`, `visitor_categories`, `barred_entries`, all with a company ID and row-level security.
- Tests: 6 new rules tests and 9 new server tests, including that another company cannot see or change any of it. Clicked through in a browser as the administrator and as a company manager, and at phone width.

**Nothing uses these settings yet.** No visitor is recorded until step 2. Removing old visitor records after the keeping period is built with the records themselves.

**Not yet proven:** by the owner on the server. (The owner said "go ahead" to step 2 on 7 Oct 2026 without reporting a test of step 1.)

### 7 Oct 2026: visitor management, step 2 of 7, scan a visitor in (D-40)

- **Gate phones.** On the site's page, under Visitors, each of the site's post phones can be given a gate. Only a phone with a gate shows the green **Visitors** button on its home screen. Retiring a gate, or moving the phone to another site, makes it an ordinary post phone again.
- **On the gate phone**, Visitors, then NEW VISITOR, one step at a time so only one camera is open at once:
  1. **The vehicle** (the default): scan the licence disc. Number plate, make, model, colour, VIN and expiry fill in. If it will not scan, the guard photographs the disc and types the details.
  2. **The driver:** driver's licence (photographed, and surname, initials and ID number typed, as the spec decides for now), or scan an ID card or ID book, or a passport (photographed and typed). An ID book's barcode holds only the number, so the guard types the name.
  3. **The visit:** passengers, the kind of visitor, and the unit they are here to see (or "the office" where the site has a client). Then **Request approval**.
  - **On foot:** a photo of the visitor's face first, then the ID; no vehicle and no passengers.
- **A returning visitor** is recognised by ID number or number plate, at that site only.
- **Barred list:** a barred ID number or number plate is caught as soon as it is scanned. The guard is told not to let the visitor in, the attempt is saved as Denied, and the people responsible for the site get a "Barred visitor" alert that names no one.
- **Expired licence or disc:** ignored while "Expired licence acceptable" is on. When it is off, the guard is warned, decides, and his choice is recorded.
- **What is kept:** only the fields the spec lists. A photo of a document is kept only when its details were typed by hand; the server drops one sent with a scanned document. A face photo is kept only for a visitor on foot. The audit trail records every scan check and every visit without copying ID numbers, number plates or names into it.
- **On the website,** the site's page shows "Visitors at the gate": the last 50 visitors, with ID numbers showing their last four characters only. Supervisors and managers of the site can see it.
- **The scanner** reads the barcode types on licence discs and ID cards (PDF417) and ID books (Code 39) with the open ZXing library already in the app, at a higher camera resolution than QR codes need, trying the picture both upright and on its side.
- Migration `0031_visits.sql`: `visitor_people`, `visitor_vehicles`, `visits`, `visit_documents`, and `devices.gate_id`.
- Tests: 12 new server tests, 12 new phone-logic tests (including reading a generated licence disc barcode upright and turned), 1 new rules test.
- Also: GitHub's build now shows failed tests and phone app build errors on the run's summary page; and a test that sometimes failed by racing the alert service's own timer now waits for it.

**Stops at "Awaiting approval".** Asking the customer on their phone, the two-minute wait and the phone call are step 3. Until then the gate phone says so after each visitor.

**Needs signal.** Saving a visitor without signal is step 7.

**Proven 7 Oct 2026:** the owner scanned a real licence disc on the gate phone ("it took the make, model, colour, everything") and scanned in a visitor on foot; he had not yet retested everything when he said to go on. Written before that test: scanning a real licence disc and a real ID card could not be proven here. The barcode layouts are written from how these documents are known to be laid out, and tested only against barcodes generated to that layout. If a real disc or card does not read, "type it in" still works, and the layout is corrected from what the owner reports.

**Not built yet:** viewing the kept photos (face, typed documents) on the website; that comes with the approval screen (the customer sees the face photo) and the supervisor's screens.

### 7 Oct 2026: visitor management, step 3 of 7, approval (D-40)

- **The customers of the unit are asked.** When the guard taps Request approval, everyone with the customer app for that unit gets the alert "Visitor at <gate>". A visitor for the office goes to the client. The locked screen says only "A visitor is at the gate. Open On Par to answer."
- **In the customer app,** Home shows the visitor waiting with **Accept** and **Refuse**: name, vehicle, passengers, kind of visitor and gate, and the face photo for a visitor on foot. Never the ID number. The first answer for the unit counts; anyone else in the unit is told who answered. Each look at a face photo is recorded.
- **On the gate phone,** a waiting screen counts down the site's wait (120 seconds unless changed) and asks the server every three seconds. Accept shows **LET THEM IN**; Refuse shows **TURN THE VISITOR AWAY**.
- **No answer:** "No response. Dial the customer?" The phone dials the unit's main number (the first person in the unit with a number). The guard sees "Unit 14", never the number: the server hands it to the phone only once the wait is over, and the call screen shows the label. After the call he records **Approved by phone**, **Denied by phone** or **No answer**. After No answer he can dial the second contact (if the site allows it), and when every number has been tried, **Nobody answers: turn away** closes the visit as "Denied, no response".
- **A unit where nobody uses the app** goes straight to the phone. With no number either, the visitor cannot be let in.
- The customer can still answer in the app while the guard is dialling; whichever comes first counts and the other is refused.
- **A barred visitor** is never put to the customer.
- **Records:** every answer and every call is kept in `visit_approvals` (append-only), and in the audit trail, without phone numbers. The website's visitor list shows who answered.
- Migration `0032_visit_approval.sql`.
- Tests: 13 new server tests, 2 new phone-logic tests. The tenant's Accept and Refuse were run in a phone-sized browser.

**On a phone where On Par is not the calling app** (a test phone that is not yet managed), the call opens in the phone's own dialler, which shows the number. Hiding it fully needs On Par set as the calling app, as on a managed gate phone.

**Not yet proven:** the alert arriving on a real tenant's phone, and the call from a real gate phone.

**Still to come:** announcing visitors (step 4), so the tenant is not asked each time.

**Proven 7 Oct 2026 (owner, build 0.1.119):** after freeing the install problem (the gate phone was 97% full), the owner reported visitor scanning and approval "working well now". Then confirmed: one visitor accepted, one refused, and one left unanswered until "Dial Unit 14" came up ("everything came through beautifully").

**Raised by the owner, 7 Oct 2026, for step 5:** the same ID was scanned in twice and both visits were accepted; the phone only said the person had been here before. A person (or vehicle) who is already on site, or still waiting for an answer, must not simply be scanned in again. Proposed for step 5, where scanning out is built: the gate phone says "Already on site since <time>" and the guard must first deal with the open visit (scan it out, or close it as "Left without scan-out" with a note). Owner to confirm: stop outright, or warn and let the guard decide.

### 7 Oct 2026: visitor management, step 4 of 7, announced visitors (D-40)

- **In the customer app,** a new **Visitors** tab: "Tell the gate who is coming".
  - **One visit:** the visitor's name, kind of visitor, the day, an optional time, and optionally which gate.
  - **A regular:** days of the week, optional hours, and optional first and last days. A fixed-period contractor must have a first and a last day.
  - **How the gate will know them:** at least one of number plate, ID or passport number, or cell number. It will not save without one.
  - The list shows who is expected and who is a regular, and each can be removed. A unit sees only its own list; ID numbers show their last four characters.
  - **"Let them in next time without asking"** on a visitor the unit has let in: the pass takes the ID number and number plate from that visit, so the customer never types or sees the ID number.
- **At the gate,** the phone checks what was scanned against today's list. On a match it shows **EXPECTED by Unit 14**, who announced them, and a **Let them in** button; no approval is asked. The kind of visitor and the unit come from the announcement.
  - **By cell number:** on the last screen the guard can type the cell number of a visitor who says they are expected.
  - **Timing:** a day only means any time that day; with a time, from an hour before to an hour after. A regular only on their days, within their hours and dates. Outside that, the visitor is treated as unannounced and the customer is asked.
  - **Partial match** (the ID matches but the number plate does not, or the other way round): let in, and the customer is told what did not match.
  - **A different gate** from the one named: still let in; the guard sees which gate was named (owner's answer 1).
  - **One entry:** a one-visit announcement is used up by one entry, unless the site switches that check off.
  - **A barred visitor is never let in on an announcement.**
- **Expected today** on the gate phone's Visitors screen: who is due, for which unit, when, and what they are known by (never an ID number in full).
- **The customer is told** when their visitor arrives, and, three days before it ends, that a fixed-period contractor's time is nearly up.
- Migration `0033_visitor_passes.sql`: `visitor_passes`, `visits.pass_id`.
- Tests: 13 new server tests, 3 new rules tests, 2 new phone-logic tests. Announcing, a regular, removing, and "let them in next time" were run in a phone-sized browser.

**Not built:** the website does not yet show staff the list of announced visitors (it shows each visit as "Expected: announced by the customer"). The one-time PIN to a visitor's cell number stays off (needs SMS).

**Not yet proven:** by the owner on real phones.

**Changed 7 Oct 2026 (owner):** the gate asks "Are you expected?" first. The Visitors screen has an **EXPECTED VISITOR** button next to NEW VISITOR: the guard types the visitor's cell number, ID number or number plate (or taps the name under Expected today) and sees the announcement at once. The visitor is then still scanned in full, licence disc and driver's licence, and is let in on the announcement only if the scan (or the cell number) matches it; otherwise the customer is asked as for any unannounced visitor. The owner chose this over looking up without scanning. The Expected today list moved onto that screen.


**Proven 7 Oct 2026 (owner):** announcing a visitor and the EXPECTED VISITOR button, on the real phones ("Brilliant. Works very well").

**Decided 7 Oct 2026 (owner):** a visitor scanned in while still recorded as on site is **not stopped**. The guard is warned and decides, and must give a reason (option B).

### 7 Oct 2026: visitor management, step 5 of 7, leaving and exceptions (D-40)

- **VISITOR LEAVING** on the gate phone's Visitors screen, with the number on site now.
  - The guard scans the licence disc, or the ID of a visitor on foot (either can be typed if it will not scan). The entry record comes up: who, what vehicle, how many passengers, who they came to see, when. For a visitor on foot, the face photo taken on the way in is shown; each look is in the audit trail.
  - The guard answers "Is <name> driving?" and counts the passengers leaving, then taps SCAN OUT. Everything matching closes the visit as **Exited** with the time, the guard and the gate.
- **Exceptions (the spec's four):** different driver, different vehicle (or left on foot, or a walker leaving in a vehicle), passenger count differs, not recorded as on site.
  - The guard must pick a reason or type a note; a photo is optional. He then chooses **LET THEM GO** or **DO NOT LET THEM GO**. His decision is recorded against him. Nothing stops a visitor by itself.
  - Let go: the visit closes as **Exited with exception**. Not let go: the visit stays **On site**, and can be scanned out properly later.
  - The supervisor and the people of the unit are alerted at once. The lock-screen text names nobody.
  - "Exit match" off: a different driver or vehicle is not an exception. "Pax count" off: passengers are not asked or compared.
- **Already on site (owner's option B):** at scan-in the phone shows **ALREADY ON SITE**, with when and where the person or vehicle came in. The guard gives a reason; the earlier visit is closed as **Left without scan-out** with an exception for the supervisor, and the new visit carries on as usual. A barred visitor is still turned away and the earlier visit left alone.
  - The same person scanned again for the same unit while still waiting for an answer: the phone goes back to the waiting visit; no second visit is made.
- **On the website,** a site's page has **Visitor exceptions**: open ones first, with the guard's reason and decision. A supervisor or manager clears one with a note of what was found; cleared ones stay visible for 30 days. What was raised cannot be changed or deleted. The visitor list shows when each visitor left.
- **In the customer app:** "Your visitor has left" (can be switched off under My account, Visitor alerts) and "something did not match" (always sent).
- Migration `0034_visit_exit.sql`: exit columns on `visits`, `visit_exceptions`, `customers.mute_exit_alerts`.
- Tests: 14 new server tests, 4 new rules tests, 3 new phone-logic tests. The exceptions card and the tenant's switch were run in a browser.

**Differs from the spec, for the owner to know:**
- The spec has the guard scan the driver's licence again on the way out. The phone cannot read a driver's licence (answer 6 of the plan), so the guard compares the driver with the entry record and answers Yes or No. The record says the driver was "confirmed by the guard", not "scanned".
- For "not recorded as on site", an unknown ID number is not kept (only the guard's note); an unknown number plate is kept, so the supervisor can see which vehicle it was.

**Not built yet:** staff cannot yet open an exception's photo on the website (it shows "photo kept"). Overstays and the handover are step 6. Scanning out without signal is step 7.

**Not yet proven:** by the owner on real phones.

**Proven 7 Oct 2026 (owner, build 0.1.129):** scanning out, exceptions and the already-on-site warning, tested "in lots of different ways". The owner agrees with the guard confirming the driver on the way out in place of a second licence scan.

### 7 Oct 2026: visitor management, step 6 of 7, on-site list, overstays and handover (D-40)

- **ON SITE NOW** on the gate phone: everyone scanned in and not out, with vehicle, passengers, unit, kind of visitor, when they came in and how long they have been on site. Visitors past their time are at the top in red.
- **When a visitor is past their time** (only with the site's "Overstay alert" check on):
  - The category's limit: so many hours on site, or gone by a time of day. For an announced visitor also the end of the day announced; for a regular, the end of their hours or of their fixed period. Whichever comes first.
  - The gate phone sounds once and its Visitors button turns red with the number waiting.
  - The guard can **Dial the customer** (the number is not shown), or type a note and choose **Still on site** or **Left, not scanned out**. "Left" closes the visit as Left without scan-out, as an exception for the supervisor. Any visitor on the list, overstay or not, can be marked as left this way.
  - If the guard has not confirmed or closed it within the site's escalation time (30 minutes), the supervisor is alerted, once. A phone call alone does not count as dealt with.
- **HAND OVER SHIFT** on the gate phone:
  - Shows the on-site list. Each visitor past their time needs an action taken in this handover; an earlier confirmation does not carry over. Sign-off is refused until each has one.
  - Saved with the guard, the time, the on-site count, and each overstay's action and note. An overstay that was only phoned about is "unresolved" and the supervisor is alerted.
  - **Duty From on a gate phone is refused until the guard has signed off a handover in this shift** (owner's answer 7). The home screen shows HAND OVER SHIFT in its place. An ordinary post phone is not affected; a supervisor's release and a late-sent Duty From are not held up.
  - **The incoming guard** sees "HANDOVER FROM <name>" at the top of Visitors, with the counts and notes, and taps **I HAVE READ THIS**. Both names are saved. A confirmation made in the handover holds for the new shift.
- **On the website,** a site's page has **Visitors on site now** (overstays first, with what the gate did) and **Visitor handovers** (who handed over to whom, the count, the notes, and "Not yet" where nobody acknowledged).
- **In the customer app,** Home shows **On site now** for the customer's own visitors, and **History** lists their last 100 visitors with anything that did not match.
- Migration `0035_visit_handover.sql`: `visit_overstays`, `visit_handovers`, `visit_overstay_actions` (append-only).
- Tests: 15 new server tests, 5 new rules tests, 3 new phone-logic tests.

**Choices made where the spec is silent, for the owner to know:**
- A visitor let in **after** their category's time of day (a contractor at 18:00, limit 17:00) has until that time the next day, so he is not red the moment he comes in.
- An announced visitor's time ("about 14:30") is when they arrive, not how long they may stay, so it is not used as an overstay limit; the day is.
- The incoming guard's acknowledgement is asked for but does not block his work.
- The guard is alerted on the gate phone itself (sound, red button). Guards have no alert feed of their own outside the app.

**Not built yet:** working without signal (step 7). The supervisor dashboard, reports and emergency roll-call follow after step 7.

**Not yet proven:** by the owner on real phones.

**Raised by the owner, 7 Oct 2026 (D-45, to plan after step 7):** the shift handover should be more than visitors. Wanted: an itemised equipment list set up per site (cell phone, radio, and so on) that the outgoing guard checks off and the incoming guard confirms; a handover note, with a voice note as a nice-to-have; and one handover screen that passes from the old shift to the new. The visitor handover built here is meant to become one part of that screen.

### 7 Oct 2026: two kinds of visitor in place of five (D-46)

The owner found the five visitor types meaningless at the gate. Decided the same day:

- **Visitor:** anyone coming to see someone, visit the office or deliver. **No time limit.** Nothing goes red because time has passed; who is still inside is picked up when the guard hands over his shift.
- **Contractor:** anyone coming to do work on site (plumber, electrician). **Out by 18:00**; after that he shows as past his time for the guard to check with the customer.
- The site can still give any kind a time limit, and add kinds of its own.
- "Regular" and "fixed period" are no longer kinds. The customer chooses **one visit** or **a regular** when telling the gate who is coming, with days, hours and an optional first and last day. A regular with a last day gets the three-day warning, whatever kind they are.
- On the gate phone **Visitor is already chosen**; the guard taps Contractor when it applies.
- On the website the list is called **Kinds of visitor** and the "Approval lasts" column is gone.
- Migration `0036_two_visitor_kinds.sql`: on sites that still have the five starting types, "Once-off visitor" becomes Visitor (limit removed), "Contractor, once-off" becomes Contractor (18:00), and the other three are taken out of use. Announcements made under those three move to Visitor or Contractor. A type an administrator renamed is left alone. Past visits keep the type they were recorded with; nothing is deleted.

**Still to talk through with the owner:** how once-off and regular contractors should differ in their access rules.

**Raised by the owner, 7 Oct 2026 (D-47, to plan after step 7):** staff of a unit (cleaners, gardeners) as a third way in at the gate, with the last six digits of their cell number and a photo compared with a reference photo. See OPEN_DECISIONS.

### 7 Oct 2026: contractors are registered by the customer; the customer is asked automatically (D-46)

Decided by the owner the same evening, replacing the Visitor/Contractor choice at the gate:

- **At the gate nobody chooses a kind.** Anyone unannounced is a visitor; the customer approves and he goes in.
- **A contractor is someone the customer registered** under "Tell the gate who is coming": **A contractor**, with his cell number (required), the **workers who may come with him**, and the time he **must be gone by** (18:00 unless the customer sets another), for one visit or over days and dates.
- **At the gate** a registered contractor comes up as EXPECTED with "CONTRACTOR: up to N workers, gone by HH:MM". The guard counts the workers in (and out, as passengers are). **More than approved:** he is not let in on the registration; the customer gets the usual request, saying how many arrived and how many were approved.
- **Still on site at the time to be gone by:** the customer is asked automatically in their app, once: "Your contractor is still on site." They answer **Still busy until** (a time; nothing goes red, and the question comes again at that time) or **Should have left** (the gate shows it in red and the supervisor is alerted at once). No answer: red at the gate, supervisor after the site's 30 minutes, as before. A customer can also give "still busy until" before being asked. The same question is asked for any visitor a site has given a time limit.
- **Guards do not phone about overstays:** the Dial button is off the on-site and handover screens. In a handover each overstay needs a note and "Still on site" or "Left, not scanned out".
- Migration `0037_contractor_passes.sql`: contractor, workers and time on `visitor_passes`; `visits.leave_by` and `stay_asked_at`; `visit_stay_answers` (append-only).
- Tests: 6 new server tests, 2 new rules tests, 1 new phone-logic test.

**Not built:** an SMS to the contractor himself (needs an SMS provider). A one-visit registration whose contractor arrived with too many workers and was then accepted is not marked as used.

**Not yet proven:** by the owner on real phones.

**Decided 7 Oct 2026 (owner):** nobody phones or messages a contractor. The tenant approved him, so the tenant is asked; nothing further is to be built for this.

### 7 Oct 2026: a simpler "Tell the gate who is coming", and quieter alerts (owner)

The owner found the tenant's form complicated ("One visit / A regular", then "A visitor / A contractor").

- **The form now reads top to bottom:** **A visitor** or **A contractor**; **who is coming**; **when are they coming** (today is already filled in); **That day only** (already chosen) or **More than one day**. The quick case is a name, one way for the gate to know them, and Tell the gate.
- **More than one day** opens the last day (empty: until removed from the list), which days, and optional hours.
- **A contractor** adds his cell number, the workers with him and the time to be gone by. A visitor has none of these: passengers are not registered in advance.
- The optional "about what time" is off the form; an announced visitor is let in any time that day.
- **Alerts that are only for information** ("your visitor has arrived", "has left", "a request was answered") still reach the phone but no longer add to the red count on Alerts. Under My account, Visitor alerts, the customer can switch **arrived** and **left** off. Anything that needs an answer is always sent and always counts: a visitor at the gate, a contractor still on site, something that did not match. An arrival where the plate or ID did not match what was announced is always told.
- Date and time boxes no longer run past the right-hand edge on an iPhone.
- Migration `0038_customer_arrival_alerts.sql`. One new server test. The form was walked through in a phone-sized browser for a quick visitor and a two-week contractor.

### 7 Oct 2026: staff of a unit (D-47), plan approved by the owner the same evening

- **Registering.** In the customer app, Visitors, **My staff**: name, cell number, optional ID number, working days and hours, optional last day. On the website the administrator can do the same for any unit (**Staff of units** on the site's page). The list shows the six digits each person gives at the gate, whether they are on site, and when they last came and went.
- **At the gate,** a new **STAFF OF A UNIT** button. The guard types the last six digits of the worker's cell number. One match is chosen at once; where two people share the digits, the guard picks from their names.
  - **First day:** the guard scans the ID (or types it, with a photo of it) and takes the reference photo. If the unit gave an ID number, the scanned one must be the same. A barred ID is refused.
  - **Later days:** the reference photo is shown and the guard takes a snapshot. He taps **SAME PERSON: LET IN**, or **Not the same person**, which asks for a note and then **LET THEM IN** or **DO NOT LET THEM IN**.
  - **Automatic photo matching** is a site check, **off to start** ("Automatic photo matching for staff"). When on, the phone says "look like the same person", "not sure" or "may be a different person". It only advises: a doubtful result means the guard must give a note to let them in, and a clear match changes nothing about who decides.
  - Any doubt, by the guard's eye or the comparison, is a **Staff photo in doubt** exception for the supervisor, and the unit is told, whichever way the guard decided.
  - **Not due** (wrong day, outside hours, past the last day): not let in as staff; the guard scans them in as a visitor and the customer is asked.
  - **Leaving:** the six digits again, then **LEAVING: SCAN OUT**.
- **No approval is asked** on a working day. The unit gets "your staff member has arrived" and "has left", both information-only and both can be switched off.
- **Staff are on the on-site list and in the handover** under the name the unit gave. With finishing hours set, a staff member still on site after them is asked about like a contractor: "still busy until" or "should have left".
- **Removing** someone stops their access at once; the record is kept.
- Migration `0039_unit_staff.sql`: `unit_staff`, `visits.staff_id`, the "staff" capture method, the `face_mismatch` exception.
- Tests: 10 new server tests (one runs the real face comparison on test photos), 3 new rules tests, 3 new phone-logic tests.

**For the owner to know:**
- A staff member's daily entry keeps the snapshot taken at the gate, like a pedestrian's face photo.
- **Legal, not decided here:** keeping reference photos and comparing them automatically for people who are not employees. The owner's view is that a face seen at a gate is public; whether POPIA needs consent or a notice for this is for a specialist. The automatic comparison stays off until an administrator switches it on.
- Staff come in on foot in this version: a staff member's own vehicle is not recorded.

**Not yet proven:** by the owner on real phones.

### 7 Oct 2026: staff by vehicle, and automatic matching that lets a clear match in (owner)

- **On foot or by vehicle.** When a staff member is registered, the tenant or administrator chooses **Comes on foot** or **Comes by vehicle** and, for a vehicle, gives the number plate. At the gate the guard sees "In CA900100", "On foot today" and "Another vehicle" (which takes a plate). They are let in whichever it is; a different vehicle, or walking in on a day, is noted on the visit. A staff visit by vehicle shows the plate on the on-site list.
- **Automatic photo matching is on to start** (the owner's decision), and decides a clear match by itself: the guard takes the snapshot and the phone lets them in, with nothing to press. The visit is recorded as decided by the comparison.
- **Any doubt goes to the guard:** "not sure" or "may be a different person" needs his note and his decision; "no clear face" lets him retake the photo or decide by eye. He can also press **Not the same person** over a match that is still on the screen. Every doubt is an exception for the supervisor and the unit is told, as before.
- A site can still switch the check off; the guard then compares by eye every time.
- Migration `0040_staff_vehicle.sql`. One new server test, and the matching test now covers a match let in automatically.

**Legal, still for a specialist and not decided here:** the comparison now decides entry by itself for a clear match, on stored photos of people who are not employees. The owner's view is that a face at a gate is public. Whether POPIA needs each worker's consent or a notice for this is to be confirmed; the switch is there if the answer is no.

### 7 Oct 2026: coming on duty, two guards on one phone, lock or roam (D-48)

The owner found Duty On clumsy: a PIN to sign in, then everything open while not on duty, then a second PIN for Duty On.

- **Tap your name, one PIN.** The sign-in screen ("Come on duty") lists the guards rostered at this site whose shift starts within three hours or is running and who are not on duty yet. The guard taps his name and types his PIN. **My name is not here** keeps the ID card scan and the typed number, for a relief guard not on the roster. With nobody rostered, or no signal, the card scan shows as before.
- **Signing in is coming on duty.** A guard who is not on duty goes straight from his PIN to Duty On and its declaration and selfie. The PIN is still asked for Duty From. (The brief, section 6.1, asked for the PIN again at Duty On; the owner has replaced that.)
- **Nothing opens before Duty On.** A guard who is signed in but not on duty (for example Duty On was refused) sees his shift, DUTY ON, PANIC, BOLO, Call and Log out. Visitors, Patrols, Tasks, Report and the rest appear once he is on duty.
- **ANOTHER GUARD: DUTY ON** on the home screen. The guard holding the phone stays on duty; the second guard taps his name, types his PIN and does his own declaration and selfie. The phone then goes back to the first guard without a PIN, because it never left the post. If the second guard gives up, Back returns it the same way.
- **The primary is the guard holding the phone.** The home screen says who that is and lists who else is on duty, each with **Take over** (his PIN). What is done on the phone is recorded, and scored, under the guard holding it at the time.
- **Lock or roam.** On the site's page, **Positions: lock or roam** lists the site's guards; each is **Roams** or **Locked to** a position (a post phone, by its post name). Supervisors and managers can change it.
  - A locked guard who comes on duty as the second guard on his own position's phone keeps the phone.
  - A locked guard who comes on duty on another position's phone is told "You are posted at Main gate", may carry on, and the supervisor gets a "Guard at another position" alert.
  - A roaming guard can take the phone from a locked guard with his PIN.
- Migration `0041_guard_postings.sql`. Tests: 6 new server tests, 3 new phone-logic tests.

**For the owner to know:**
- A guard can no longer sign in on a post phone just to look at his score or roster before his shift: signing in puts him on duty. A supervisor's own phone is unchanged.
- The sign-in list shows names and shift times to anyone who picks up the post phone. It shows no numbers; the PIN is still needed.

**Not yet proven:** by the owner on real phones. This changes how every guard comes on duty, so it should be tried on one phone before it goes to a site.

## Test-site maker (owner's request, 7 Oct 2026)

For testing with more sites, phones and visitors. On **Sites**, the administrator sees **+ Test site**. One tap makes "Test site N":

- two gates (Main gate, Back gate), Day and Night shifts of two guards;
- units 1 to 12, each with one tenant sign-in (`unitN@xxxx.onpar.test`), all with one password shown once on screen, no forced change at first sign-in;
- four announced visitors from the owner's test sheet (units 1 to 4: two visitors for two weeks, one contractor with 3 workers, one today-only visitor) and two staff of a unit (unit 5 on foot, code 111111; unit 6 by vehicle TEST09GP, code 222222); units 7 to 12 are left empty for unannounced visitors.

Everything is made up: ID numbers have month 13, plates start with TEST, cell numbers start with 0000. Passes and staff are made through the same services tenants use, so the same rules and audit entries apply; the maker itself writes one audit entry (`site.create_test`, no password in it).

**Not made:** guards and phones. A guard is a real enrolment (photos, ID, PSIRA), so the owner moves a guard to the test site and registers a phone there as usual.

**For the owner to know:** a test site cannot be deleted (nothing in On Par is), and it shows in the site list and dashboards like any other site. Server endpoint `POST /api/test-sites`, administrator only. Tests: 3 new server tests.

## Emergency panel (owner's request, 7 Oct 2026)

After PANIC, and on the Call screen, the post phone shows an **EMERGENCY** panel: Police, Fire brigade, Ambulance, Armed response.

- **PANIC is unchanged and goes first.** The alert is sent and the phone calls the control room exactly as before (D-27). The panel is on the panic screen underneath.
- **Nothing on the panel dials by itself.** The guard taps the service he needs; the call uses the mobile network, so it works with no data.
- **Police** opens to two choices when the site has its local station's number: **10111** and the **local station**. With no local number it is one button, 10111.
- **Fire brigade** and **Ambulance**: the site's own number; **10177** only when the site has none.
- **Armed response**: only when the site has a number. The button carries the company's name and, when one is uploaded, its **logo** (kept on the phone, so it shows with no signal).
- **Set per site** on the site's page: a new **Emergency numbers** card (name and number for each) and an **Armed response logo** card (JPEG/PNG/WebP up to 1 MB). These numbers are approved contacts, so the locked-down phone can dial them and nothing else.
- **Every tap is recorded** (`emergency_calls`, never changed): the service, local or national, which phone, the guard if signed in, the time, and the panic it followed. The number itself is not stored. The panic page on the website and in the supervisor app lists "Emergency numbers the guard phoned". Audit action `emergency.call`.
- Migration `0042_emergency_panel.sql`. Rules in `packages/rules/src/emergency.ts`. Tests: 3 rules, 5 server, 1 phone-logic.

**For the owner to decide or know:**
- The national numbers (10111 police; 10177 ambulance and fire) are in one place in the rules and can be changed.
- While the phone's automatic call to the control room is in progress, the in-call screen covers the panel; the guard sees the panel when that call ends. Whether PANIC should keep dialling the control room by itself now that the panel exists is the owner's decision (D-27 stands until he says otherwise).
- Phones on an older app version show the emergency numbers as plain rows in the Call list.

**Not yet proven:** on a real phone. No real emergency number should be dialled when testing: use the test site with made-up local numbers, and do not tap 10111 or 10177.

### Change the same evening: PANIC no longer phones anyone by itself (owner, 7 Oct 2026)

The owner corrected the flow. This replaces the automatic control room call of D-27.

- **PANIC sends the alert and opens the panel.** The alert goes to everyone responsible for the site (control room users, supervisors, managers), worded "John Smith at Estate ABC has pressed the panic button (Main gate)." The locked screen of the receiver's phone still shows only "Panic at Estate ABC".
- **The panel after PANIC has five buttons:** Control room first, then Police, Fire brigade, Ambulance, Armed response. The guard taps who he needs. On the Call screen the control room stays in the ordinary contacts list above the four emergency buttons.
- A tap on Control room is recorded like the others (migration `0043_control_room_call.sql`).
- The website no longer says "The phone could not start a call"; it lists who the guard phoned from the panel, or that he has phoned nobody yet.

## The Wire, first part (owner's rule book and build specification, 8 Oct 2026; D-49)

The guard reward programme, built so the owner can run it through the pilot (about 10 sites and 50 guards for three months) and tune its values on real shifts before the store opens. Source documents: "The Wire rule book" and "My Wire build specification" (Claude Docs, linked from the project note `the-wire-decisions.md`).

**What it does now**
- **Engine** (`apps/api/src/wire/`, rules in `packages/rules/src/wire.ts`). Every 15 minutes, and on demand, it pays barbs from what On Par already records:
  - per worked shift: ready for duty (on duty 15 minutes before the scheduled start), duties complete (no task of his, or of his post in his shift, left open or missed; an accepted "could not complete" counts as done), clean handover (every report he raised in the shift closed or assigned);
  - at month end: the monthly score (attendance and job performance pillars, weights as in the specification, measures with nothing to count left out), the standard award (95% or more; 20, +5 a month in a row, up to 40; one short month in twelve keeps the run) or else the improvement award (1 point above his own three-month average), long service (2 a month worked), anniversaries (25), new skill (25 per course or grade recorded in Training);
  - entry barbs from a recruitment score the owner enters (once).
- **Launch credit** for service before The Wire (50 a completed year) is worked out from the joining date the owner enters. It counts on the Wire and toward insignia, never as available barbs, and can be corrected by changing the date.
- **Ledger** `wire_entries`: append-only, one row per rule per shift or month, so re-runs and late corrections only add what is newly due. Month snapshots `wire_months` are locked.
- **The Wire page** on the website (menu "The Wire"; managers see it, only the administrator changes it): each guard's Wire, available barbs, this month, pace, and months to silver and gold at that pace; barbs issued by month and source with the rand cost; Bob Wire's fastest silver and gold, with a warning if gold could come in under three years; every value editable; **Try these values** replays the real months under changed values and compares, writing nothing; **Save as the values in force** applies them from then on; each guard's every barb, months, joining date and recruitment score; the day The Wire started (settings).
- **My Wire on the post phone** (home screen button next to Score): insignia, Wire total and drawing, available barbs, this month by source, months in a row at the standard, barbs to the next insignia and months at his pace, his months, latest barbs. Nothing negative, no rand, no other guards.
- Migration `0044_the_wire.sql`; permissions `wire.view`, `wire.manage`. Tests: 12 rules, 10 server, 1 phone-logic.

**Not yet built (later phases of the specification):** store and hand-ins with fulfilment, goals, Thuthuka notes, approvals queue (customer praise, discretionary awards, BOLO results), mentoring, fast response, recognition board and milestones, alumni mode, the programme report per franchisee.

**For the owner to know**
- The Wire starts on the day the page is first opened. To count shifts already worked, set **The Wire started on** in the values and save.
- Joining date defaults to the day the guard was enrolled in On Par; set the real date on The Wire page for long service and launch credit.
- Patrols are not yet part of "duties complete"; tasks are.
