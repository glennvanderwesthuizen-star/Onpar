# ON PAR: Claude Code Build Brief

Version 2.1, 27 September 2026
Prepared for The Security Franchise (TSF)
Status: final working brief for the initial build. Where it differs from earlier versions, this brief wins. Sections 1 to 15 are the MVP foundation. Section 16 onward, starting at "16. Employee portal", was Phase 2. "24. Report visual indicators" onward, through section 35, was added after hands-on testing of the working prototype (v2.0). Section 36 onward is the final round of fixes and additions before build starts (v2.1). Build in the order the milestones table (section 11) and the revised milestones (section 34) describe.

## 1. How to use this brief

You are building **On Par**, a performance-management and operational-accountability platform, starting with private security companies. The owner is not a developer. Explain things in plain language, work in small steps, show progress often, and ask when a decision is needed instead of assuming.

Files you have been given:

- **This brief.** The source of truth.
- **OnPar\_Prototype\_Reference.html.** A clickable prototype. Open it in a browser. It has tabs for the guard device, management, setup, the employee portal, HR and the spec. It shows every screen and rule described here, and its "Spec addendum" tab repeats the rules. Section 14 lists what the prototype simplifies.

Your first action is not to write app code. Do this instead:

1. Read this brief and open the prototype.
2. Write a short project plan and list your questions (section 13 has the known open decisions).
3. Propose the technology stack and confirm it with the owner.
4. Start Milestone 0 (section 11), the hardware spike.

Working rules:

- Write automated tests for the scoring engine, patrol rules, recurrence, offline sync and tenant separation.
- Keep hardware independence. Never build logic for one phone brand into the core app. "Managed Android device" is the requirement.
- Never put secrets or personal data in the repository. Use migration scripts for the database.
- Do not build anything on the excluded list (section 3).
- Legal and compliance points (labour law, POPIA, firearms, PSIRA) are flagged in this brief. Do not decide them yourself. Flag them to the owner and build the configurable option.
- Time is always server time in Africa/Johannesburg.

## 2. Product summary

- **Proposition:** Measure the work. Manage the performance. Close the loop.
- On Par is not a guard-monitoring app. It is a workforce performance system that starts in security.
- It answers five questions: Were you supposed to be there? Did you arrive? What were you supposed to do? Did you do it? If something went wrong, what happened afterwards?
- **Brand idea:** golf's "par" stays in the brand only. Employees see simple points and three positions: Above Par, On Par, Needs Attention.
- **Device:** the guard uses an "On Par Management Device", a company-issued, managed Android rugged phone. Blackview is only the first test model. On Par is the only thing the guard sees (kiosk mode).
- **Branding:** the TSF logo appears on the login screen and header. A client logo slot (for example Standard Bank) is reserved. TSF must supply the client's logo file and have permission to use it.

## 3. Scope

**In the MVP:** identity and PIN login; Duty On and Duty From with declarations and selfies; attendance; tasks with recurrence; patrols with QR and GPS lock; reports with full close-out; re-orders and issued kit; scoring; qualifications and training expiry; basic managed calling; kiosk mode and device management; management dashboard; officer enrolment; site setup.

**Explicitly excluded from the MVP:**

- Live bodycam streaming
- Advanced BOLO network
- Panic hardware and man-down sensors
- AI surveillance
- Automatic facial recognition or face matching
- Continuous GPS tracking
- Payroll
- Biometric hardware
- Industry-wide intelligence network
- Advanced control-room dispatch
- Sophisticated telecommunications
- Firearm registers beyond recording a quantity (needs specialist advice first)
- Full rostering

**Phase 2, after the MVP works (sections 6.14 to 6.17):** an employee portal on the guard's own phone, personal queries, warning and disciplinary notices with delivery tracking, and the franchise model. Do not let Phase 2 delay the MVP.

**Design for, but do not build:** BOLO, panic, camera and bodycam, stock control, push-to-talk and VoIP, analytics, a contractor login, and management functions inside the app.

## 4. Architecture

Managed Android device, then the MDM and kiosk layer, then the On Par mobile app, then the On Par API, then the cloud database, then the management web dashboard.

| Area | Recommendation (confirm with the owner) |
| --- | --- |
| Mobile app | Native Kotlin. Kiosk, dialer, camera, QR and GPS need native control. |
| Backend | PostgreSQL and a REST API (NestJS or Django). |
| Multi-tenancy | A company ID on every record, plus row-level security from day one. A franchisee is a tenant and the franchisor sits above the tenants (section 6.17). |
| Dashboard | React or Next.js. |
| Hosting | A South African region (AWS Cape Town or Azure South Africa North). |
| Notifications | Firebase push, plus an SMS provider for fallback and links. |
| Employee portal (Phase 2) | A web application that works in any phone browser with a personal login. No app store needed. |
| Files | S3-compatible object storage for photos and certificates. |
| MDM | Chosen in Milestone 0. Candidates: Android Management API, Hexnode, Scalefusion, SOTI, Headwind MDM. |
| Kiosk | Android Enterprise dedicated-device (lock task) mode through the MDM. Not merely an app that hides the Exit button. |

## 5. Roles and permissions

| Role | Can do |
| --- | --- |
| Employee (guard) | Own shift, tasks, patrols, reports, follow-ups, re-orders, score and evidence. |
| Site supervisor | Assigned sites and staff. Creates tasks, assigns and follows up reports, awards up to +2 points. |
| Site manager | As supervisor for the site, plus receives Red priority reports and orders. |
| Company manager | Whole company. Closes reports, approves overrides and reversals, edits scoring rules, enrols officers. |
| System administrator | Setup, sites, devices, users, approved contacts. |
| Client or estate manager | Read-only summary for their site. |
| Contractor (later) | Own assigned jobs only. In the MVP the supervisor records contractor work. |
| HR administrator (Phase 2) | Issues notices, handles queries, sees personal and disciplinary records. Site supervisors do not by default. |
| Payroll clerk (Phase 2) | Handles pay and hours queries. Sees pay-related data only. |
| Franchisor administrator (TSF) | Sees aggregated figures across franchisees and publishes standard templates. No personal HR data unless agreed in writing. |
| Franchisee owner or manager | Everything within their own company. |

Every action is written to an audit log. Data is separated by company.

## 6. Functional requirements

### 6.1 Login, identity and devices

- A device belongs to a post (for example Gate 2), not a person.
- Each guard has an employee number and a 4 to 6 digit PIN. PIN is required to log in and again for Duty On and Duty From. Five wrong attempts lock the account until a supervisor resets it.
- At shift change the outgoing guard logs Duty From and logs out. Nothing is recorded under the previous user.
- A supervisor can log Duty On for someone, only with a reason, and it is audited.
- Optional per-site setting, off by default: a one-time site location check at Duty On (not tracking).
- Device records: device ID, serial or IMEI, company, site, assigned post, status, kiosk status, app version, last connection, battery. Actions: register, assign, reassign, lock, disable, retire, update configuration (depending on the MDM).

### 6.2 Duty On, Duty From and declarations

- Arrival is **Duty On**. Departure is **Duty From**. (Wording as supplied by the owner; confirm before release.)
- Logging Duty On records attendance and opens a separate declaration screen. The guard cannot use the rest of the app until it is completed.
- **Duty On declarations, all three required:**
  1. "I am fit and free of injury and ready to commence and complete my shift"
  2. "I have read the OB and understand the tasks for the day"
  3. "I have taken receipt of all equipment handed over from the previous shift, all in good order"
- **Duty From declaration:** "I am fit and free of injury and departing from duty, I have handed over all assigned equipment and handed over any information required by the incoming shift"
- A selfie is mandatory at Duty On and at Duty From.
- A Comments tab lets the guard record anything, for example a broken piece of equipment. He can also raise the comment as an equipment report, which enters the normal report workflow.
- Each record stores the wording shown (with a version number), server time, device time, device, employee, selfie, comment and the statements accepted. Records cannot be edited or deleted.
- If a declaration is left incomplete, attendance shows "declaration pending" for the supervisor.
- Injury reports link back to that guard's Duty On declaration so management can see what he declared.
- The purpose is protection against injury-on-duty fraud. A declaration is evidence, not proof. The owner should have an employment lawyer review the wording and how it interacts with injury-on-duty claims.
- No automatic face matching in the MVP. A supervisor can view the selfie next to the registration photos.

### 6.3 Attendance

- Flow: scheduled, Duty On, work, Duty From.
- Record: employee, site, shift, scheduled start, actual arrival, scheduled finish, actual departure, status, exception, supervisor.
- Statuses: ON TIME, LATE (with minutes), EARLY DEPARTURE, ABSENT, APPROVED EXCEPTION.
- Grace period: up to 5 minutes after the start is ON TIME (proposed).
- Attendance events feed the scoring engine.

### 6.4 Tasks and recurrence

- A task has an assignee (a person or a post), a date, a time, and an evidence rule such as a required photo.
- Recurrence: one-off, daily, weekly, monthly (same day each month). Every-N-hours can come later. Example: check all fire extinguishers on the 19th of every month.
- **The server generates each occurrence on schedule, whether or not the previous one was completed.** An occurrence not done by its deadline becomes overdue and then missed. (The prototype creates the next one only on completion. Do not copy that.)
- Each occurrence keeps its own history, evidence and exception reason.
- "I could not complete this task" with a reason (equipment unavailable, access unavailable, emergency, supervisor instruction, other), optional photo and comment. It carries no penalty until a supervisor reviews it.

### 6.5 Patrols

**Patrol types.** A site defines patrol types. Example: A is an internal patrol, B is an external perimeter patrol, C is a guard room check-in that is a single QR scan. Each type has its own patrol points and its own three rules. Settings are per site and shift pattern, so day and night can differ.

**The three rules per type:**

1. Patrols per shift. The shift is split into equal windows, one patrol per window (4 patrols in a 12 hour shift gives 3 hour windows).
2. Minimum gap between patrols. The next patrol of that type cannot start until the gap has passed since the last one finished. This stops a guard doing all patrols at once.
3. Maximum duration. The clock starts at the first scan. This is the man-down safeguard.

Warn the administrator when gap plus maximum duration do not fit inside a window.

**Doing a patrol.**

- The guard chooses the patrol type. The app shows what is due and when the next one opens. Only one patrol can be active at a time.
- Patrol points are scanned in any order. Route order is not enforced.
- Verification is a **QR scan with GPS lock**. A scan counts only if the phone has a GPS fix with accuracy of 25 m or better and is within the point's radius (30 m, proposed). A photographed code scanned from elsewhere is rejected and logged. The MDM blocks mock-location apps and developer options. Repeat scans within 2 minutes are ignored.
- Location is captured only at the moment of a scan, never continuously.
- A single-scan type completes with its one scan.
- A guard who cannot finish a multi-point patrol gives a reason. It is marked partial with no penalty until a supervisor reviews it.

**Overdue alert.**

- If a started patrol is not finished within its maximum duration, an alert goes to the supervisor (dashboard and push).
- If nobody acknowledges within 10 minutes it escalates to the control room.
- It clears when the patrol is completed or a supervisor confirms the guard is safe.
- The guard's screen shows time left.
- Limit: the server can only run the timer once it receives the first scan. With no signal, the phone counts down and sounds a local alarm, and the server learns on sync. This is a timeout alert, not a panic button or man-down sensor.

**Patrol point instructions and checks.** Each patrol point can have:

- A special instruction shown when the guard arrives.
- A photo: off, optional or required.
- A note: off, optional or required.
- Readings: a number with a unit and a limit (for example generator fuel in litres, flag below 50), OK or Problem, or a photo.

The point counts as done only when the required items are saved. A reading outside its limit, or Problem, raises an Amber report automatically. Readings are stored as data so trends can be reported later. Managers can create patrol points and edit all of this.

**Patrol points (scoring).** Each site and shift pattern has one patrol points allocation, for example 6 at one site and 10 at another. It is shared equally across all required patrols, so every completed patrol earns its full share and completing all earns the whole allocation. A missed patrol earns nothing. Calculate cumulatively with rounding so the total is exactly the allocation. A penalty for missed patrols is a configurable rule (default 0). Keep fractions and show two decimals.

### 6.6 Reports and close-out

- Anyone can report. Categories: Security, Safety, Injury, Maintenance, Equipment, Client issue, Staff issue, Observation, Other. Priority Green, Amber or Red. A photo and comment (voice-to-text allowed).
- Every report routes automatically to the site supervisor, plus the site manager for Red. Routing is configurable per site.
- Reports are also created automatically from failed patrol checks and from declaration comments.
- **Stages:** Reported, Assigned, Actioned, Attendance checked, Job inspected, Closed.
- Every stage records who did it, their role, a note and the time. History is append-only.
- **Assigned:** the higher level assigns it to a person from the people directory (staff or contractor: name, role, phone, internal or contractor).
- **Actioned:** the assignee (for example a plumber) does the repair. In the MVP the supervisor records this for contractors. Later the assignee gets app access and submits their own job report with photos.
- **Attendance checked:** the higher level confirms the assignee attended. Later this can be backed by the contractor's own time and location stamp.
- **Job inspected:** the security officer on site is sent an inspection task, checks the work and records Job done or Not fixed. Not fixed sends the report back to Assigned with the reason.
- **Closed:** the manager signs off. The reporting guard receives a positive performance event.
- **Guard follow-up.** The guard who reported can follow up on his own report at any time once it is assigned, without waiting for the higher level. He records what he found: not started yet, work in progress, repair done and OK, or not fixed, with an optional note and photo. It goes into the history and flags the report for the higher level. "Repair done, all OK" after attendance has been checked completes Job inspected. "Not fixed" after the work was actioned sends the report back to Assigned. Other officers on site can follow up too, and repeat follow-ups are allowed.
- Management can report "400 reported, 387 resolved, 13 outstanding" from this data.

### 6.7 Re-orders and issued kit

- Employee registration records the uniform and equipment issued: shirt, trousers, jacket, boots or shoes, cap, belt, reflective vest, raincoat, radio, torch, key set (list configurable per company). Uniform items have sizes. Equipment has asset numbers. Allocating an item sets an issue date.
- In the guard's Report function there is a category **Re-order**. The guard chooses **Personal** or **Site**.
- **Personal:** he picks from the items issued to him. The system fills in his size or asset number from his profile. The comment gives the reason (for example damaged while chasing a suspect).
- **Site:** free text (for example toilet paper, 2 packs). No fixed list.
- **Stages:** Requested, Ordered, Assigned, Delivered, Received. Each records who, role, note and time. "Assigned" means assigned to a person to deliver it (owner to confirm). The guard confirms Received on his device. For a personal item the issue date then updates.
- Later: approval limits, stock levels, supplier orders, cost tracking. Whether the company recovers replacement costs from an employee is a labour-law question. Do not build automatic deductions.

### 6.8 Scoring engine

- A separate module. Never hard-code points in other modules.
- The database stores individual performance events (employee, event type, impact, date, site, source, evidence). Events are append-only. A reversal adds an offsetting event and never deletes.
- Score = 80 + points from the last 30 days, kept between 0 and 120, with a daily cap of plus or minus 5.
- Positions: Above Par 90 or more. On Par 70 to 89. Needs Attention below 70.
- Rules are editable per company. Defaults are in section 10.
- The employee sees why the score changed (for example +1 task completed, -1 late arrival, +2 outstanding performance).
- Every negative event shows its evidence and has a Query button. The employee has 7 days to query and a supervisor answers within 3 working days.
- Supervisors can award up to +2. Larger awards and every reversal need a manager.
- Points inform a conversation. They never trigger discipline, deductions or dismissal automatically. Have an employment lawyer review the rules.

### 6.9 Qualifications and training

- Record per employee: course or qualification, completion date, expiry date, certificate upload, status (COMPLIANT, EXPIRING, EXPIRED).
- PSIRA registration (number, grade A to E, expiry) is tracked the same way. Firearm competency, first aid and fire fighting are examples of others.
- Expiry dates feed the dashboard figures. A learning management system is out of scope.

### 6.10 Calling and kiosk

- Calling is basic and belongs in the MVP: call, answer, decline, end call.
- The guard sees only administrator-approved contacts for his site (supervisor, site manager, control room). No dialpad.
- Incoming cellular calls show the caller with Answer and Decline. Calls must never let the guard escape kiosk mode.
- Cellular voice is used, so calls work without data. Do not build a telecoms network.
- Kiosk: the device boots into On Par. The guard cannot reach the Android home screen, settings, app installation, browser or other apps.

### 6.11 Management dashboard

- Today: scheduled, on time, late, absent.
- Tasks: completed, outstanding, overdue.
- Reports: open, action required, overdue.
- Re-orders open. Patrol alerts open and patrol compliance per type.
- Training: compliant percentage, expiring, expired.
- Performance: needs attention.
- Drill-down: Company, then Site, then Employee, then Event, showing shift, attendance, tasks, reports, actions, training, performance events and comments.
- Duty declarations with selfies and comments. Checkpoint readings. Device status.

### 6.12 Officer enrolment

- For now, done by a management person on the web dashboard (Setup). Later, a manager can enrol and assign on the app. That needs a management login on the device: the role is decided at sign-in, managers get a Manage section, and management functions stay hidden on post devices unless a manager signs in with stronger credentials.
- **Personal:** full name, SA ID number (13 digits, with a check-digit test), cell number, next of kin and number, PSIRA number, PSIRA grade, PSIRA expiry, assigned site.
- **Qualifications:** each with expiry and certificate upload.
- **Photos, all four required:** face close-up, full body in uniform, ID document, PSIRA card.
- **Uniform and kit:** items with sizes and asset numbers.
- **Checks:** the officer's grade against the site's minimum grade, and a valid firearm competency for an armed site. A failed check shows a warning. A manager override with a reason is proposed.
- Verify PSIRA registration against PSIRA's official records by hand for now. No integration is assumed.
- Show the ID number masked (last four digits).

### 6.13 Site setup

- A site has a name, address or area, client, minimum PSIRA grade and an armed or unarmed flag.
- Any number of shifts, each with name, start, end and guards required.
- Equipment quantities per shift: radios, torches, handheld devices, firearms, vehicles (list configurable).
- Approved contacts: supervisor, site manager, control room.
- Patrol types, patrol points and rules are set up after the site exists.
- Coverage indicator: officers assigned against the minimum needed for one day. Real rosters need relief guards, so proper rostering is later.
- Firearms are heavily regulated. Record quantity only, until a firearms compliance specialist advises on registers, serial numbers, sign-out and sign-in at shift change, and competency checks.

### 6.14 Employee portal (Phase 2)

- Two doors. The **post device** is shared, locked down and stays on site, for operational work. The **employee portal** is for personal matters, used on the guard's own phone or any browser, anywhere, with a personal login.
- Personal and HR content is never shown on the post device. It shows only a generic line such as "You have a personal message. Open it on your own phone or see your supervisor."
- The portal is a web application, so nothing needs installing. Proposed login: employee number, PIN and an SMS code. Links arrive as an app notification or SMS. A native personal app can come later.
- Notifications are in two classes: operational (shifts, tasks, alerts) go to the post device; personal (queries, notices) go to the portal. Lock-screen text is generic. Unacknowledged personal notices escalate to a person.
- Guards without smartphones or data must still be reachable by paper and hand delivery. Who pays for data on personal phones is an open point.

### 6.15 Queries (Phase 2)

- One workflow for Pay, Hours worked, Leave, Uniform and kit, Personal details, Grievance and Other.
- Stages: Submitted, Received, Assigned, Responded, Closed. The employee confirms resolved or reopens it. Every stage records who, role, note and time.
- Queries go to HR or payroll, never to the site supervisor, and are confidential. Grievances have restricted access.
- Pay and hours queries can attach the employee's On Par attendance record as evidence.
- Payslips and payroll integration are out of scope until later.

### 6.16 Warnings and disciplinary notices (Phase 2)

- The app supports the process and produces proof. It never decides anything and never creates a warning automatically from scores. A manager may cite performance events as evidence.
- Only authorised HR or management roles can issue notices, from templates a labour lawyer has approved. Types: verbal warning record, written warning, final written warning, notice of disciplinary hearing (date, time, venue), hearing outcome, general message.
- Delivery tracking: Sent, Delivered, Opened, Acknowledged, each with a time. Acknowledging receipt does not mean admitting anything.
- If a notice is not acknowledged within a configurable period (60 minutes in the prototype, longer in real use), HR is prompted to arrange hand delivery and the signed copy is recorded. An app notification alone may not be valid notice, so ask a lawyer.
- Records are immutable. Retention is set with the lawyer.
- Later stages, not yet designed in detail: investigation, hearing record, outcome, appeal, warning expiry, employee responses.
- Check the private security sector bargaining council's rules before finalising the process. Do not decide legal points yourself.

### 6.17 Franchise model (Phase 2)

- Hierarchy: franchisor (TSF), then franchisee (each a separate company tenant), then site, then employee.
- Each franchisee's data is separated from every other franchisee's. TSF sees aggregated figures across franchisees (compliance, patrol adherence, incidents closed, training) but no personal HR data unless agreed in writing.
- TSF publishes standard templates: patrol types, checklists, declaration wording, scoring defaults, notice templates. Franchisees adopt them and may customise within limits.
- Branding: the TSF logo, plus the franchisee's own where wanted.
- Onboarding a franchisee creates its company, an administrator and its sites.
- No public app store is needed. Franchisee phones are set up through the MDM and the portal is a website. Charging (per guard, per device or a flat fee) belongs in the franchise agreement.
- The franchisee is normally the employer and the responsible party under POPIA. TSF's role and access need written agreements. Get legal advice before rollout.

## 7. Data model (minimum)

| Entity | Key fields |
| --- | --- |
| Company, Site | Name, address, client, minimum grade, armed flag, contacts, patrol points allocation. |
| Shift definition, Shift | Site, name, start, end, guards required, equipment quantities. Roster entry: who works when. |
| User, Employee | Role, PIN hash, employee number, ID number (protected), PSIRA number, grade, expiry, cell, next of kin, site, status, photos. |
| Device | Device ID, serial or IMEI, site or post, status, kiosk status, app version, last seen, battery. |
| Approved contact | Site, label, number. |
| Attendance | Employee, shift, scheduled and actual times, status, exception, server and device time. |
| Declaration | Employee, type (Duty On or Duty From), wording version, statements accepted, comment, selfie, times. Immutable. |
| Task, Task occurrence | Assignee, schedule, evidence rule. Occurrence: due date and time, status, evidence, exception. |
| Patrol type, Patrol point, Patrol rules | Site, type, points, per-point instruction, photo and note settings, readings with limits, patrols per shift, gap, duration. |
| Patrol instance, Scan, Reading, Alert | Window, status, times. Scan: QR code, GPS position, accuracy, result. Alert: raised, acknowledged, escalated, cleared. |
| Report, Report history | Category, priority, routing, stage, assignee. History: stage, person, role, note, time. |
| Follow-up | Report, guard, outcome, note, photo. |
| Re-order, Re-order history | Kind (personal or site), item, size, comment, stage. History as for reports. |
| Issued item | Employee, item, size or asset number, issue date. |
| Performance event, Scoring rule | Employee, event type, impact, source, evidence. Rule: event type, points, company. |
| Qualification | Employee, type, completion, expiry, certificate, status. |
| People directory | Name, role, phone, internal or contractor. |
| Notification, Audit log | Recipient, message, time. Audit: who, what, when, before and after. |
| Query, Query history (Phase 2) | Employee, category, text, attached attendance, stage. History: stage, person, role, note, time. |
| Notice, Notice delivery (Phase 2) | Type, employee, subject, details, hearing date, time and venue, times sent, delivered, opened and acknowledged, hand-delivery record. Immutable. |
| Organisation (Phase 2) | Franchisor, franchisee (tenant company), branding, licence details. |

## 8. Offline and sync

- Guards often work with poor signal. Every action (Duty On, tasks, scans, reports, declarations) is saved to a local outbox with a unique ID and device timestamp, so retries never create duplicates.
- Sync happens automatically when signal returns. Text goes first, photos after, compressed. The phone shows how many items are queued.
- The server accepts events up to 72 hours old and flags them "late-synced" for the supervisor.
- While offline, time uses the device clock plus elapsed time since the last server sync. The server reconciles on upload. Drift over 2 minutes is flagged. The MDM enforces automatic network time.
- Conflicts: the server wins on shifts and task definitions. The device wins on events it created.
- Checkpoint definitions and the approved contacts are cached on the device.

## 9. Security, privacy and legal

- Secure authentication, role-based permissions, company data separation, encrypted communication and storage, hashed PINs and passwords, audit trail, backups and a tested recovery process.
- POPIA: employees receive a notice listing exactly what is recorded. Employees can see their own data. Keep data minimal. TSF needs a registered Information Officer and an operator agreement with the developer and host. Keep a breach-response procedure.
- ID copies, selfies and photos are sensitive. Restrict who can see them. Get advice from a POPIA specialist, especially about photos used to identify people.
- Proposed retention (confirm with legal): selfies and patrol photos 12 months; attendance, tasks and performance events 3 years; audit log 5 years; training records while employed plus 3 years; registration photos while employed plus a period agreed with legal.
- Location is captured only at scans, and only as configured. No continuous tracking.
- Personal, pay and disciplinary data is more sensitive than operational data. Keep it in separate tables with its own roles and audit trail. Disciplinary records can be special personal information, so get POPIA advice.
- **Flag to the owner, do not decide:** labour-law treatment of scores, declarations and any cost recovery; firearms handling; PSIRA verification; POPIA treatment of photos.

## 10. Default values (all proposed and configurable)

| Setting | Default |
| --- | --- |
| ON TIME grace period | 5 minutes after start |
| GPS accuracy required for a scan | 25 m or better |
| Patrol point radius | 30 m |
| Duplicate scan window | 2 minutes |
| Alert escalation to control room | 10 minutes unacknowledged |
| Clock drift flagged | Over 2 minutes |
| Late-synced events accepted | Up to 72 hours old |
| PIN lockout | 5 wrong attempts |
| Score base and range | 80, kept between 0 and 120 |
| Score window and daily cap | 30 days, plus or minus 5 per day |
| Positions | Above Par 90 or more, On Par 70 to 89, Needs Attention below 70 |
| On time / task completed / training completed / report closed | +1 each |
| Outstanding performance | +2 |
| Late / missed task | -1 each |
| Missed shift | -2 |
| Missed patrol | 0 (patrol points are earned per completed patrol) |
| Query window | 7 days to query, 3 working days to answer |
| Supervisor award limit | +2 |

## 11. Milestones and build order

| # | Milestone | Done when |
| --- | --- | --- |
| 0 | **Hardware spike.** Real rugged phone plus a chosen MDM. | The phone boots straight into On Par with no way out. It can call only approved contacts. An incoming call can be answered and ended without leaving kiosk mode. QR scanning and GPS lock work on the device. Fixed-price estimate for the rest. |
| 1 | Foundation. | Companies, sites, users, roles, device registration, login, audit log, tenant separation, Setup screens for sites and officer enrolment. |
| 2 | Duty On and Duty From, attendance. | Declarations, selfies, comments, statuses, offline outbox, server time. |
| 3 | Tasks. | Assignment, scheduled recurrence, exceptions. |
| 4 | Scoring engine. | Events, rules, positions, "why my score changed", queries, reversals. |
| 5 | Reports and close-out. | Routing, all stages, people directory, inspection task, guard follow-up. |
| 6 | Patrols. | Types, rules, QR and GPS lock, instructions and checks, alerts and escalation, patrol points. |
| 7 | Re-orders and kit. | Issued items, personal and site re-orders, stages, receipt. |
| 8 | Qualifications and training. | Expiry tracking and compliance figures. |
| 9 | Management dashboard. | All figures and the drill-down. |
| 10 | Hardening. | Security review, backups and recovery test, POPIA checklist, load test. |
| 11 | Pilot. | One site, real guards, real devices. |
| 12 | Phase 2: employee portal and queries. | Personal login, generic post-device line, query workflow with attendance attached, confidentiality enforced. |
| 13 | Phase 2: notices. | Templates, issuing, delivery tracking, hand-delivery fallback, immutable records. |
| 14 | Phase 2: franchise model. | Franchisee onboarding, tenant separation, franchisor aggregated dashboard, shared templates. |

## 12. Acceptance scenarios (turn these into automated tests where possible)

1. **Walkthrough.** An administrator creates a site and enrols John Smith, assigns Device 001, and the device enters kiosk mode. John logs in, sees his 06:00 shift, logs Duty On at 05:57 (ON TIME), completes the declaration with selfie, completes the Generator check with a photo, sees a damaged gate and reports it. The supervisor assigns maintenance, the report goes through every stage to Closed, and John gets a positive event. Next day he arrives 06:17 and gets -1 Late arrival, and can see why. He presses Call, Supervisor, and the supervisor answers.
2. **Patrol gap.** After finishing internal patrol 1, starting patrol 2 is blocked until the minimum gap has passed.
3. **Patrol overdue.** A started patrol not finished by its maximum duration raises an alert. Unacknowledged for 10 minutes it escalates. Completing the patrol clears it.
4. **Spoofed scan.** A QR scan 480 m from the point is rejected and logged. A scan with poor GPS accuracy is rejected.
5. **Any order.** Points scanned in any order complete the patrol.
6. **Patrol points.** With a 6 point allocation and 13 required patrols, each patrol is worth 6/13 and completing all 13 sums to exactly 6.00.
7. **Point checks.** Fuel of 30 litres against a limit of 50 raises an Amber report automatically. A required photo blocks saving until taken.
8. **Report lifecycle.** All six stages record who, role, note and time. The guard's follow-up "Not fixed" sends the report back to Assigned. "Repair done, all OK" after attendance is checked completes Job inspected.
9. **Recurrence.** A monthly task creates its next occurrence on schedule even if the previous one was missed.
10. **Declarations.** The guard cannot proceed until the selfie and all three statements are done. Records cannot be edited. An injury report shows the Duty On declaration.
11. **Enrolment.** Enrolment is blocked without all four photos and required fields. A grade below the site minimum, or no firearm competency at an armed site, shows a warning.
12. **Re-order.** A personal shirt re-order fills the size from the profile. It goes through Requested to Received and the issue date updates on receipt.
13. **Offline.** Actions taken offline sync later without duplicates and are flagged late-synced. Scan times are reconciled.
14. **Tenant separation.** A user from one company can never read another company's data.
15. **Scoring.** Events are append-only. A reversal adds an offsetting event. The daily cap holds. Changing a rule changes future scores.
16. **Portal.** A notice never shows its details on the post device or the lock screen. The employee sees it only after a personal login on the portal.
17. **Notice tracking.** Sent, Delivered, Opened and Acknowledged are each time-stamped. An unacknowledged notice past the period prompts hand delivery, and the signed copy is recorded.
18. **Queries.** A pay query goes to payroll or HR only. A site supervisor cannot see it. The attendance record attaches. The employee can reopen a response.
19. **Franchise.** Franchisee A can never read franchisee B's data. The franchisor sees aggregates only.

## 13. Open decisions for the owner

- Which MDM and which rugged phone model to standardise on (settled by Milestone 0).
- Native Kotlin or a cross-platform approach (recommendation is native).
- Hosting provider (AWS Cape Town or Azure South Africa North).
- Whether "Assigned" in re-orders means assigned to a person to deliver.
- Whether "Duty From" is the intended term (it may be "Duty Off").
- When contractors get their own login.
- Whether to weight patrol types differently in patrol points.
- How to import the existing QR product's codes as patrol points, if it can export them.
- Firearms scope, after specialist advice.
- Retention periods and photo handling, after legal advice.
- When to add the management mode inside the app.
- Getting permission and the logo file for the client logo slot.
- How guards log in on their own phones (employee number, PIN and SMS code is proposed) and who pays for data.
- The acknowledgement period before a notice is flagged for hand delivery.
- Who acts as HR in a small franchisee.
- What TSF may see across franchisees, agreed in writing.
- How franchisees are charged (per guard, per device or a flat fee).

## 14. What the prototype simplifies

The prototype is a single web page with demo data. It is a behavioural reference, not code to reuse.

- It keeps everything in memory and simulates the camera, GPS, selfie and calls. It has one guard and a fixed demo date.
- Its clock is set from the script panel.
- It creates the next recurring task only when the current one is completed. The real system generates on schedule.
- Contractors are recorded by the supervisor. There is no contractor login.
- It has no editing of enrolled officers, no override for failed grade checks and no reading-type editor.
- Coverage is a simple count, not a roster.
- The portal and HR tabs simulate SMS, login and delivery. There is one guard and one HR view. The investigation, hearing record and appeal stages are not built.

## 15. Files

- OnPar\_Claude\_Code\_Build\_Brief.md (this document; a PDF copy exists for reading)
- OnPar\_Prototype\_Reference.html (the clickable prototype)

---

# Addendum: features added in v2.0

Everything below was added after the MVP and Phase 2 sections above were written, based on hands-on use of the working prototype. Treat it as equally binding. Where a fix corrects an earlier assumption, the correction here is authoritative.

## 24. Report visual indicators

- Every report is assigned a distinct colour the moment it is created (a small palette, cycled), shown as a coloured badge with the report number wherever the report appears: the management close-out list, the guard's own report list, and the Electronic Occurrence Book (section 27). While a report is open its colour is reserved; once it reaches Closed, that colour becomes available for reuse by the next new report. Purpose: at a glance, tell reports apart in a long list without reading every number.
- Priority (Green, Amber, Red) is shown as a small flat "traffic light": three dots in a row, the two inactive ones greyed out and only the true priority lit in colour. Used in place of a text badge in the Electronic Occurrence Book's Alert column. The full-word priority pill (as in the original MVP) is still fine elsewhere; this compact form is specifically for dense tabular views.

## 25. Untimed tasks by default

- A task's scheduled time is now optional. When assigning a task, "Specific time required" defaults to off. An untimed task has no due time and is shown to the guard as available any time during the shift, rather than against a due time.
- Only tick a specific time when the task genuinely must happen at that time. This changes the default from the original MVP wording (section 6.4), which implied every task had a due time; that is no longer the case.

## 26. Gamification (private, moved from "later" into scope)

Section 18 (in the original Phase 2 addendum) sketched this; it is now built and should be treated as in-scope, not speculative:

- Visible only after the guard's own login, never to a supervisor or on any shared screen. Celebrates; never ranks people against each other.
- Levels: a name (Recruit, Officer, Senior Officer, Ace Officer, On Par Elite are the working names) based on a running count of the guard's own positive scoring events. Separate from the 0–120 score that management sees; this is a private long-run measure of consistency.
- Streaks: consecutive on-time arrivals, and consecutive fully-completed patrols, computed by walking back through the guard's own event history until it hits a break (a late arrival, or a missed patrol).
- Badges: earned for a pattern of good work in a single shift, for example completing every required patrol, or closing a report within the same shift.
- Celebration: a one-time private pop-up overlay on the guard's phone when a streak or level milestone is first reached. Each milestone celebrates once; track which have already fired so the same one does not repeat.
- A leaderboard remains optional and, if built later, should be opt-in or scoped to a team, never a default public ranking of named individuals.

## 27. Electronic Occurrence Book (EOB), built

Section 20 (Phase 2 addendum) described this as a next step; it is now built as a working aggregation view and should be treated as in-scope:

- A single time-ordered table for one site, one day, assembled automatically from records the rest of the system already keeps: Duty On/From declarations, attendance, task completions and exceptions, every patrol scan and checkpoint check, every stage a report or re-order moves through, notice delivery events, query stages, and firearm allocation/return (section 29). Nothing is entered twice.
- Columns: time, category (with the report colour badge from section 24 where relevant), an alert indicator (the flat traffic light from section 24, blank for non-report rows), a photo indicator, the entry text, and who recorded it.
- Photo column: a small indicator wherever a photo was captured as part of that entry (a Duty declaration selfie, a required task photo, a patrol checkpoint photo, a report submitted with a photo). It should show the actual captured image once the real camera is wired in; the prototype uses a placeholder icon because a browser prototype has no camera, and says so.
- A prominent banner states this is not the official Occurrence Book and does not replace the site's existing legal paper or electronic OB, which continues as normal.
- Should support a landscape-oriented wide view on a phone (rotate to view), and is naturally wide already on a tablet or desktop.
- Retention should match or exceed whatever the real Occurrence Book's legal retention requirement is.
- Later: date-range filtering, guard/site/category filters, PDF export for handover or audit, free-text entries for anything not automatically captured, search.

## 28. HR document templates and suggested actions, built

Section 19 (Phase 2 addendum) sketched this; it is now built in more detail:

- Template ladder, each auto-filling from the employee record (name, employee number, site, date) and counting how many prior warnings of that kind are already on file: Verbal warning record, Written warning, Severe written warning, Final written warning, End of line memorandum, Notice to appear for disciplinary inquiry, Hearing outcome, General message.
- Notice to appear for disciplinary inquiry is a compound document: the charge, hearing date/time/venue, the employee's rights (informed of the charge in a language and terms understood; reasonable time to prepare; representation by a fellow employee or shop steward; no interpreter, since the inquiry is conducted in English; the right to state a case and cross-examine witnesses; a written outcome with reasons and a right to appeal), a witness list HR builds item by item, and a representative field.
- Every template is a drafting aid only. A labour lawyer must approve the actual wording, the warning ladder, validity periods and the disciplinary process before real use. The relevant bargaining council's rules may impose requirements beyond this.
- Suggested actions: the system can notice a pattern (for example, three late arrivals with no written warning yet on file) and show HR a banner naming the pattern, with a button that only pre-fills the notice form. It never issues, sends, or generates a warning by itself. A person always decides. This preserves the existing MVP rule (section 6.8) that scores and event counts never trigger discipline automatically.
- Fixed during testing: the send action previously failed silently if the subject line was left blank after using a template. It now defaults the subject from the notice type and charge if left blank, and shows a clear inline message if it is somehow still empty, rather than doing nothing.

## 29. Firearm allocation and return, armed sites

New in v2.0, not previously specified:

- Trigger: an employee assigned to a site marked armed (section 15) gets a required Firearm step as part of Duty On, and a required Firearm return step as part of Duty From, alongside the existing declaration and comments steps (section 11). Neither Duty On nor Duty From can be confirmed until its firearm step is complete.
- Allocation (Duty On) captures: the firearm assigned to that post (make, calibre, serial number, from a site armoury register); rounds of ammunition issued; holster issued and fits; bullet-proof vest issued and worn; a condition check (functions correctly on a dry check only, never a live-fire test; no visible damage to the firearm or holster; safety catch engages and disengages correctly); a photograph of the firearm and its serial number; and a safe-handling declaration ticked line by line (trained in safe handling; keeps it holstered with the safety engaged unless there is immediate lawful need; never points it at a person unless lawfully justified; reports any loss, theft, discharge or malfunction immediately; accepts personal accountability for the firearm and ammunition while in their possession).
- Return (Duty From) captures: rounds returned; condition on return; whether there was a loss, theft, discharge or malfunction during the shift, with a note if so; a photograph; and a final confirming declaration.
- Automatic escalation: if the rounds returned do not match the rounds issued, the condition is marked damaged, or an incident is reported, a Red priority report is raised automatically to the site supervisor and site manager, and enters the normal report workflow. This is a deliberate, narrow exception to the "no automatic reports from performance data" principle, justified because it concerns a safety-critical physical asset, not a judgement of the employee's performance.
- Every allocation and return is immutable once confirmed, visible on the management dashboard's Duty declarations view, and appears in the Electronic Occurrence Book (section 27) as its own Firearm entry.
- Out of scope here: a full armoury module (multiple firearms per site, assignment by serial number to a specific post, service and maintenance history) is a later build. This does not replace a proper firearm register, competency verification, or the legal requirements around firearm custody, transport and storage. Get advice from a firearms compliance specialist before real use, as already flagged in section 15.

## 30. Site editing

New in v2.0. The original MVP had a form to create a site but nothing to change one afterwards, a real gap found during testing. Any site's details (name, address, client, minimum PSIRA grade, armed flag, every shift's name/times/guards required/equipment quantities, and approved contact numbers) can now be edited in place after creation. Editing should not need a separate save step; changes apply as they are made, matching how patrol rules and checkpoints already work elsewhere in Management. Known edge case: renaming a site can desynchronise it from employees already assigned under its old name, since that assignment is presently just a name match; a real implementation should key this relationship by a stable site ID, not by name.

## 31. Shift patterns and rostering

New in v2.0, and the fullest treatment of the roster problem so far; it replaces the very first, simpler roster sketch that appeared briefly in testing (a direct weekly grid of shift/day/slot cells with no underlying pattern) which should not be built. Build rostering as described here instead:

**The model, exactly as specified by the owner:**

- A shift pattern is a named, repeating cycle of Day, Night and Off (for example, "3 day / 3 night / 3 off", or "5 day / 2 off"), with a system-assigned two-digit ID. Patterns are created and edited independently of any one site and are reusable across sites.
- Every site's shift definitions (section 15) carry a Day or Night tag. A pattern's D and N symbols map onto whichever of a given site's shifts carries that tag, so the same pattern ID works across sites with different shift names or times.
- Allocation is: site, shift pattern, employee, start date, and position. Position is where in the pattern's cycle that employee begins. Worked example, exactly as given: the first two guards on a "3 day / 3 night / 3 off" pattern go in at position 1, so they start on a day shift; the next two go in at position 4, the pattern's fourth slot, so they start on a night shift.
- From the start date, every future date's shift is computed, not manually entered: `(position - 1 + days since start) modulo pattern length` gives the index into the pattern's sequence, which gives Day, Night, or Off for that date. This means the schedule extends indefinitely into the future without needing new rows.
- Manual override: any single employee's single day can be changed by hand without disturbing their underlying pattern or any other day. An override, once set, takes precedence over the computed value for that date going forward.

**The stated restriction, precisely:**

- No double shift. Specifically: a Night shift must never be immediately followed by a Day shift, because a night shift conventionally ends when a day shift conventionally begins (for example 06:00), giving zero rest.
- A Day shift immediately followed by a Night shift is fine and is not a violation: the day shift ends in the evening (for example 18:00), and the next occurrence of night only begins the following evening, a full day later. This is what makes patterns like "3 day / 3 night" work in practice, and the build must not block it.
- The check must be cyclic: the wrap from a pattern's last day back to its first is checked the same way as any other adjacent pair.
- Known simplification to fix in the real build: this check currently assumes the common 06:00/18:00 convention. It should really compare each site's actual configured shift start and end times, not just the D/N symbol, since a site could run different hours.

**The table, exactly as requested:**

- Top: a requirement row per shift type, drawn directly from the site's own "guards required" figures (section 15), for each day of the displayed period.
- Middle: one row per employee allocated to that site, each cell computed automatically from their pattern and position (or their manual override where one has been set for that date).
- Bottom: an actual row per shift type, counting how many people are really rostered that day (after overrides), with a clear pass/short/over indicator against the requirement row above it.
- The build shown to the owner displays one week at a time, with previous/next navigation; the underlying computation already supports any future date, so a longer view (a full pattern cycle, a month, a custom range) is a display change, not a data-model change.

**Connects to:**

- The employee portal gets a read-only "My roster" view of the same computed schedule for the displayed period.
- The attendance register report (section 32) is built directly from this roster: scheduled shift and hours per day, compared with the employee's real Duty On/Duty From times.

**Not yet built, flagged as next steps rather than skipped:** swap requests between employees; leave and relief cover; a check for one person double-allocated across two patterns or sites; and extending the display beyond a single week (the data model already supports it).

## 32. Reports module, first report: attendance register

New in v2.0. A dedicated Reports area, meant to grow into a small library of reports over time.

- First report: an attendance register, by employee, described by the owner as the document used to pay the person. It combines the roster (section 31: scheduled shift and hours) with the employee's actual Duty On and Duty From times where they exist, and shows hours worked and a status per day (complete, on duty with no Duty From yet, absent with no Duty On logged, rest day, or no record).
- It is explicitly not a payslip: it must not calculate pay rates, deductions, or leave. It is the evidentiary record a payroll process would consume, not the payroll process itself.
- Likely next reports, not yet built: patrol compliance, an incident and report summary, training and PSIRA compliance, and a re-order/kit summary. Each should ideally be exportable (PDF or CSV) for handover, audit, or a client.

## 33. Updated data model additions (v2.0)

| Entity | Key fields |
| --- | --- |
| Shift pattern | ID, name, ordered sequence of Day/Night/Off. |
| Allocation | Employee, site, pattern, start date, position. |
| Roster override | Employee, date, shift value; overrides the computed value for that one date only. |
| Firearm, Firearm allocation, Firearm return | Firearm: make, calibre, serial number, site. Allocation: employee, ammunition issued, holster/vest issued, condition checklist, photo, safe-handling declaration. Return: ammunition returned, condition, incident flag and note, photo, confirming declaration. |
| Report (extended) | Adds a colour/badge slot, reused once the report closes. |
| Task (extended) | Adds a boolean for whether a specific time is required; the due time is now optional. |
| Guard progress (private) | Level (derived from a running count of positive events), current streaks, badges earned, which celebration milestones have already fired. |

## 34. Revised milestones (v2.0 additions)

Add these to the milestones table in section 11, after the existing Phase 2 milestones:

| # | Milestone | Done when |
| --- | --- | --- |
| 15 | Report visual indicators, untimed tasks. | Colour-coded reports with reuse on close; flat traffic-light alerts; task time made optional, defaulting off. |
| 16 | Gamification. | Private levels, streaks, badges and one-time celebration pop-ups, visible only to the guard. |
| 17 | Electronic Occurrence Book. | Automatic, time-ordered, cross-module log for one site/day, with the "not the official OB" banner always present. |
| 18 | HR templates and suggested actions. | Full warning ladder and inquiry notice with rights/witnesses/representative; suggestions that only pre-fill, never send. |
| 19 | Firearm allocation and return. | Required on Duty On/From for armed sites; automatic Red report on any ammunition, condition or incident discrepancy. |
| 20 | Site editing. | Every site field editable in place after creation. |
| 21 | Shift patterns and rostering. | Pattern builder with the Night-into-Day validity check; allocation by pattern and position; computed schedule extending indefinitely; manual per-day override; requirement-vs-actual table. |
| 22 | Reports module: attendance register. | Built from the roster and real Duty On/From data; explicitly not a payslip. |

## 35. Acceptance scenarios (v2.0 additions)

16. **Report colour reuse.** Two reports open at once get different colours. Closing one frees its colour for the next new report.
17. **Untimed by default.** A newly assigned task with no time specified shows as available any time during the shift, not against a due time.
18. **Gamification privacy.** A streak or badge celebration never appears on any screen other than the guard's own, after his own login.
19. **EOB completeness.** Doing a Duty On, a patrol, a report and a re-order all produce entries in the EOB automatically, correctly time-ordered, with no duplicate entry and no manual re-keying.
20. **HR send never silently fails.** Attempting to send a notice with no subject either fills a sensible default or shows a clear message; it never does nothing.
21. **Firearm gate.** Duty On cannot be confirmed on an armed site until the firearm step is complete. Returning fewer rounds than were issued raises a Red report automatically to the supervisor and site manager.
22. **Site edit persists.** Editing a site's shift times or guard counts is reflected immediately in the roster's requirement row for that site.
23. **Pattern validity.** A pattern with Night immediately followed by Day is rejected or flagged invalid. A pattern with Day immediately followed by Night is accepted. The check wraps from the pattern's last day to its first.
24. **Roster computation.** Two employees allocated to the same pattern at positions 1 and 4 are on different shift types on the same date. Moving the displayed week forward correctly advances everyone's computed shift with no manual re-entry.
25. **Manual override precedence.** Overriding one employee's one day changes only that cell; their pattern-computed schedule for every other day is unaffected.
26. **Attendance register honesty.** The register never invents a Duty On/Duty From time that was not actually logged; a day with no real record clearly says so rather than showing a fabricated time.

---

# Addendum: final round before build (v2.1)

## 36. Shift setup, made intuitive

The site shift editor (in On Par Roster's Step 1, and in the plain site create/edit forms) was reworked after the owner found the original layout unclear. Build it this way, not as a bare row of unlabelled inputs:

- Every shift is its own card, colour-coded by type: amber for Day, blue for Night, with a matching pill badge ("DAY SHIFT" / "NIGHT SHIFT") at the top of the card so the type is unmistakable at a glance.
- Every field carries a visible label above it (Shift name, Starts, Ends), not just a placeholder.
- "Guards needed on this shift, every day" is its own clearly boxed sub-section within the card, shown as a large number with plus and minus buttons (a stepper) rather than a small typed number field. The stepper does not allow the count below 1.
- Equipment quantities are tucked under a collapsed "Equipment for this shift" disclosure, so they don't clutter the primary flow; expand only if needed.

## 37. Roster tab: a clearly delineated site selector

The top of the Roster tab is a single, strongly bordered box (a thick accent-coloured outline) containing two buttons: "Current site" and "New site". Nothing else appears until one is chosen:

- **Current site** reveals a dropdown of existing sites. Once picked, the site's name is shown large and bold inside its own inset panel, with client and address beneath it, so it is always unambiguous which site the patterns, allocation and roster table below belong to. "Edit this site" and the week-navigation controls live inside this same panel.
- **New site** shows a single button that launches the On Par Roster wizard (section: On Par Roster, guided new-site setup, in the v2.0 addendum).

Do not go back to a flat, scattered site `<select>` mixed in with other controls; the owner was explicit that the site context needed a strong, unmistakable visual anchor.

## 38. Roster allocation: clash prevention, enforced not just displayed

A real gap was found in testing: it was possible for one employee to end up allocated to two different sites at once. Fixed as follows, and this must be built as a hard invariant, not a display-only warning:

- Every path that allocates a person to a site and pattern (the guided wizard, and any direct "allocate" action) must go through one shared operation that first removes any existing allocation for that person, for any site, before adding the new one. A person can only ever have one active roster allocation at a time.
- As a second, independent safety net, the system should also actively check for and surface a clash if one is ever found (for example, from a data import, a bug elsewhere, or manual database editing), with a clear warning naming the person and every site they are incorrectly allocated to. Defence in depth: the invariant should make this warning impossible to trigger in normal use, but the check should exist anyway.
- When staffing a new site through the wizard, if a person is ticked who is already allocated elsewhere, show a warning before they are moved: "Currently rostered at [site]. Allocating here will move them off that roster." Reassigning someone between sites is a legitimate action; it must never happen silently.

## 39. Grade and firearm competency checked at allocation time too

Previously, an employee's PSIRA grade against a site's minimum, and firearm competency for an armed site, were only checked at enrolment (section 6.12). They are now also checked at the moment of roster allocation: staffing a site shows a warning, per person, if their grade is below the site's minimum, or if the site is armed and they have no firearm competency on file. This does not block the allocation, since a manager may have a valid reason to proceed and record an exception, but the mismatch must be visible, never silent.

## 40. The guard sees his real shift on the device, not only the portal

The kiosk device's home screen previously showed a hardcoded example shift. It must show the guard's actual computed schedule instead: today's real site, shift name and times (from the roster, section 31), or "Off today" if his pattern has him off, or "Not yet rostered" if nothing has been allocated to him at all. Add a short "Coming up" list of the next few days below it, computed the same way. This is in addition to, not a replacement for, the fuller My Roster view already specified for the employee portal (section 6.14) on the guard's own phone.

## 41. Payroll month, per site

- Every site has its own payroll month start day, set when the site is created and editable afterwards, defaulting to the 26th. The rationale, from the owner directly: the business pays on the 1st but needs a few days to collate information first, so the working payroll month runs from the 26th to the 25th.
- The Reports tab's attendance register (section 32) is built around this payroll period, not a calendar week: it shows the full period (for a 26th start, typically 28 to 31 days) at once, with Previous period and Next period navigation, and a short summary of shifts scheduled versus completed so far in the period.
- The day-to-day roster grid (section 31) deliberately stays on a calendar week for operational use. Only the payroll-facing report should use the payroll month; do not force the operational roster view onto payroll-period boundaries, they serve different purposes.

## 42. Updated data model addition (v2.1)

| Entity | Key fields |
| --- | --- |
| Site (extended) | Adds payroll month start day (an integer day of month, default 26). |

## 43. Acceptance scenarios (v2.1 additions)

27. **Shift setup clarity.** Creating or editing a site's shifts presents each as a distinct, colour-coded, labelled card with a stepper for guard count; nothing below 1 is reachable.
28. **Site selector.** The roster view for any site is only ever entered by first choosing "Current site" (then a specific site) or "New site"; the chosen site's name is always visible in a strong, unmistakable panel above the working area.
29. **No double allocation, structurally.** Attempting to allocate a person who is already allocated elsewhere always results in exactly one active allocation for them afterwards, at the new site, never two. A direct attempt to create two simultaneous allocations for the same person (bypassing the normal flow) is caught and surfaced as a clash warning naming both sites.
30. **Cross-checked at allocation.** Staffing an armed site with someone lacking firearm competency on file shows a warning at that moment, not only at enrolment. The same for a grade below the site's minimum.
31. **Device matches reality.** The guard's kiosk home screen always reflects his real computed shift for today, including correctly showing "Off today" and "Not yet rostered" where applicable; it never shows a fixed example unrelated to his actual roster.
32. **Payroll period correctness.** For a site with payroll day 26, the period containing 19 September starts 26 August and ends 25 September, inclusive, and is exactly 31 days long. Moving to the next period from that one starts 26 September. Moving to the previous period from the original one starts 26 July. Changing a site's payroll day changes the periods computed for it going forward.

## 44. Handing this to Claude Code

This brief (as Markdown) and the working prototype (as a single self-contained HTML file) are the two inputs Claude Code needs. Concretely:

1. Give Claude Code both files and ask it to read them fully and produce a written build plan before writing any application code.
2. Ask it to set up the project skeleton (repository, chosen stack, environment) and Milestone 0, the hardware and kiosk spike (section 11), first. Do not let it start on application screens before this is proven on a real device, since it is the highest-risk unknown and everything else assumes it works.
3. From there, follow the milestones table (section 11) and the revised milestones (section 34) in order: foundation, Duty On/From and attendance, tasks, the scoring engine, reports and close-out, patrols, re-orders, qualifications, the management dashboard, hardening, then the pilot; Phase 2 (employee portal, HR, franchise model) and the v2.0/v2.1 additions (gamification, the EOB, firearm allocation, site editing, shift-pattern rostering, the payroll month) after the MVP is solid.
4. Treat every acceptance scenario across this document (sections 12, 35 and 43) as the test suite. Ask Claude Code to write them as automated tests as each relevant milestone is built, not to add them at the end.
5. Where this brief says a legal, labour-law, POPIA, or firearms point needs a specialist's advice, that instruction is for the owner, not Claude Code: it should build the configurable mechanism described and flag the open question, not decide it.
6. Keep using the prototype as the reference for exact behaviour whenever the written brief is ambiguous; the prototype was tested screen by screen and is the more precise source for interaction detail, while this brief is the more precise source for data model, rules and rationale.
