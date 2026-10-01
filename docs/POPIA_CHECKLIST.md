# On Par: POPIA checklist

Prepared at Milestone 10 (hardening), 27 September 2026. This is a working checklist, **not legal advice**. Items marked **Owner / legal** need TSF's POPIA adviser or Information Officer. The brief (section 9) asks that these points are flagged, never decided by the developer.

## 1. What On Par already does

| POPIA condition | What is built | Where |
|---|---|---|
| **Accountability** | Every action is written to an append-only audit log, which the database refuses to change or delete. Viewing photos and ID-related data is logged. | Audit page; `audit_log` |
| **Processing limitation (minimal data)** | Location is captured only at a QR scan, a PANIC (owner's decision D-28) and the optional Duty On site check, never continuously. The post device never shows personal, pay or disciplinary data. Only what the brief lists is recorded. | Patrols, attendance |
| **Purpose specification / retention** | Photo retention setting (selfies and patrol photos, proposed 12 months), **off until switched on**, with a log of every removal. | Privacy page |
| **Information quality** | Corrections are made by adding records, with before and after kept (qualifications, PSIRA, scoring reversals). | Officers, Training, Scores |
| **Openness** | The employee notice (section 3 below) is drafted for legal review. | This document |
| **Security safeguards** | See section 2. | |
| **Data subject participation** | Officers see their own score and why it changed, their own qualifications and their own reports on the device. Negative score events can be queried. A full personal portal is Phase 2 (milestone 12). | Device, Scores |
| **Special personal information** | The SA ID number is encrypted in the database and shown masked. Photos are encrypted at rest. Disciplinary records are not built yet (Phase 2) and will sit in separate tables with their own roles. | Enrolment |
| **Cross-border transfer** | Hosting is planned for AWS Cape Town (af-south-1), so data stays in South Africa. Backups stay in the same region. | BUILD_PLAN section 3 |

## 2. Security safeguards built (section 19 of POPIA)

- **Separation between companies.** Row-level security in PostgreSQL on every table. The application's database user cannot switch it off (automated test).
- **Sign-in.** Passwords and PINs are hashed with Argon2. Website sessions use an httpOnly, Secure, SameSite=Strict cookie. Changes need a same-site header, so other websites cannot make changes on a user's behalf. After 5 wrong passwords an email address is locked for 15 minutes, and after 30 wrong attempts from one network address the same applies. A PIN is locked after 5 wrong attempts. Temporary passwords must be replaced at first sign-in, with a minimum of 12 characters.
- **Roles.** Each role sees only what it needs. Site supervisors and clients see only their own sites. A client or estate manager sees summary figures only.
- **Encryption.**
  - Every stored photo and certificate is encrypted with AES-256-GCM before it is written.
  - S3 adds its own server-side encryption.
  - ID numbers are encrypted.
  - Backups are encrypted with a passphrase.
  - All traffic must use HTTPS in production (HSTS header).
- **Uploads.** Files are checked against their real content, not just their name.
- **Headers.** A content security policy and blocking of framing, sniffing and referrers on the website and the server.
- **Backups.** Encrypted backups, with a restore that is tested automatically on every change (see OPERATIONS.md).
- **Dependencies.** The known-vulnerability audit was clean at Milestone 10. It must be re-run before each release.

## 3. Draft employee notice (for legal review)

> **What On Par records about you, and why**
>
> Your employer, **[company name]**, uses On Par to run security shifts and track work quality. This notice tells you what it records.
>
> - **Who you are:** your name, employee number, SA ID number (stored encrypted), date of birth, cell number, next of kin, PSIRA number, grade and expiry, and four photos taken at enrolment (face, full body, ID document, PSIRA card).
> - **Your shifts:** when you press Duty On and Duty From, a selfie at each, your answers to the fitness and equipment statements, and any comment you add.
> - **Your work:** tasks you complete or could not complete (with your reason and any photo), patrols (each QR scan, with the phone's location **only at the moment of the scan**, and any readings or photos), reports and follow-ups you make, and re-orders.
> - **Your performance score:** points for events such as arriving on time or a missed task, each with its evidence. You can see your score and why it changed, and you can query any negative event within 7 days. **Scores never lead to discipline or deductions automatically.**
> - **Your training:** qualifications, dates and certificates.
>
> - **Panic and BOLO:** if you hold PANIC, the phone records the time, the site, who is signed in, and the phone's location **once, at that moment**, and calls the control room. A BOLO records the photo and note you send.
>
> On Par does **not** track your location between scans or panics, and does not record calls.
>
> **Who can see it:** your supervisor and managers for the sites you work at, and administrators. Clients see only site-level figures, never your personal details.
>
> **How long it is kept:** [periods to be confirmed with legal, for example selfies and patrol photos 12 months; attendance, tasks and performance events 3 years; training while employed plus 3 years].
>
> **Your rights:** you may ask to see the information held about you and ask for it to be corrected. You may also complain to the Information Regulator. Contact the Information Officer: **[name, email, phone]**.

## 4. Draft breach-response procedure (for the Information Officer to adopt)

1. **Contain (first hour).** Whoever notices a suspected breach tells the Information Officer and the developer at once. Stop the cause, for example by deactivating a user on the Users page, locking a device on the Devices page, or rotating keys.
2. **Assess (first day).**
   - Use the audit log to establish what was accessed, whose data, when and by whom.
   - Keep evidence and do not delete logs; the audit log cannot be deleted anyway.
3. **Notify (as soon as reasonably possible, POPIA section 22).**
   - The Information Regulator, using its prescribed form.
   - The affected employees, in writing: what happened, what data, what is being done, and what they can do.
   - **Legal to confirm wording and timing.**
4. **Recover.**
   - Restore from backup if data was damaged (OPERATIONS.md).
   - Reset passwords, and reset PINs for affected officers.
   - Fix the cause.
5. **Review.** Write down what happened and the fix, and update this checklist.

Technical levers available now:
- Deactivate a user, which signs them out at once.
- Reset passwords.
- Lock, disable or retire a device.
- Reset PINs.
- Rotate `JWT_SECRET`, which signs everyone out.
- Rotate the backup passphrase for future backups.

`DATA_KEY` protects ID numbers and files. Rotating it needs a re-encryption run, which is not built yet; plan it with the developer.

## 5. Owner / legal actions still needed

| # | Action | Who |
|---|---|---|
| P-1 | Register TSF's **Information Officer** (and deputy) with the Information Regulator. | Owner |
| P-2 | **Operator agreements** (POPIA section 21) with the developer and the host (AWS). Each franchisee is a responsible party; TSF's role as franchisor to be defined (D-17). | Owner / legal |
| P-3 | Confirm the **retention periods**, then switch photo removal on (Privacy page). Decide the process for removing records after 3 and 5 years. | Legal |
| P-4 | Approve the **employee notice** (section 3) and how it is given (paper at enrolment, signed). | Legal |
| P-5 | Advice on **photos used to identify people** (selfie against the registration photo) and whether consent or another lawful basis applies. | POPIA specialist |
| P-6 | A **Personal Information Impact Assessment** before the pilot. | Information Officer |
| P-7 | Adopt the **breach-response procedure** (section 4) with names and phone numbers. | Information Officer |
| P-8 | Labour-law review of the scoring rules and declarations (brief section 9; L-items in OPEN_DECISIONS). | Employment lawyer |
| P-9 | Decide who may hold the **backup passphrase** and the `DATA_KEY` (at least two people, stored apart from the backups). | Owner |
