# On Par: next round of changes (from the owner's testing, 2 to 3 Oct 2026)

Collected while the owner tests. Legal points are flagged, not decided.

**Go-ahead given 3 Oct 2026.** Rounds A, B and C were built on 3 Oct 2026 (see the progress log in BUILD_PLAN.md). Building order:
- **Round A (every shift):** 7 (sideways photos), 1 (Log out and Lock), 2 and 3 (relief rules), 6 (declaration), 4 (points), 5 (overtime minutes).
- **Round B:** 9 (uniform flow) and 10 (uniform condition notes).
- **Round C:** 12 (BOLO voice notes and video).
- **Later:** 11 (merchandise); a proper stores app and stock-holding.

## 1. Log out and Lock while on duty

- While a guard is on duty there is no Log out. The only way off duty is **Duty From** (PIN, declaration, then the phone clears for the next guard).
- **Lock** returns the phone to the front screen but keeps the guard on duty. The front screen shows "John Smith on duty since 06:02". Only his PIN unlocks it. Another guard cannot sign in over him until he has done Duty From. PANIC, BOLO and Call still work.
- Log out stays when the guard is not on duty (for example to check his roster or score).
- A guard who leaves without Duty From stays "on duty" on the website. A supervisor ends the shift there, with a reason.

## 2. Duty From only after the relief arrives

- Duty From is locked until a relief guard does Duty On at the site, for up to **30 minutes after the shift ends**.
- After 30 minutes without relief, Duty From unlocks, the supervisor is alerted, and the post shows as uncovered.
- A supervisor can release a guard at any time from the website, with a reason (sick, family emergency).
- Early relief, one for one: each arriving guard frees one leaving guard. A guard who leaves early because his relief came does not count as leaving early.
- *Legal flag (L-07):* how long a guard may be kept, and how that time is paid, is for a labour lawyer.

## 3. Who leaves first

- First in, first out, by the leaving guards' Duty On time that morning (the earlier second breaks a tie).
- When a relief arrives, only the guard whose turn it is can do Duty From.
- That guard can give his turn to his partner with his PIN ("Let my partner go first"). It is recorded: "Sipho gave his turn to Thabo at 17:05."
- *To confirm:* the order follows the leaving guards' own Duty On time.

## 4. Points

- Duty On **more than 15 minutes** before the shift: **+1** point. 0 to 15 minutes early: no bonus (on time as now). After the start: late, as now.
- Staying past the shift for a late relief: **+1** point, plus the points the late guard loses for being late ("+2 covered for Thabo, late 25 min").
- All values on the Scores rules page. Points never trigger discipline by themselves.

## 5. Overtime minutes

- The exact minutes each guard works before or after his rostered shift, per day, shown in the attendance register and its download.
- Turned into pay by the wages module (D-26, parked). *Legal flag:* overtime pay rules for a labour lawyer.

## 6. Duty On declaration: new statement

> "I understand that I may not leave the site until my relief has arrived, for up to 30 minutes after my shift ends, unless my supervisor releases me."

Stored with a new version number. *Legal flag (L-02):* wording to be checked by a labour lawyer.

## 7. Photos showing sideways (bug)

Photos are saved with a "rotate me" mark that our screens ignore. Fix for selfies, report, patrol and BOLO photos.

## 8. PIN at Duty On

Owner decision: **ask for the PIN at Duty On every time** (no change; signing in does not put a guard on duty).

## 9. Uniform: catalogue, site lists, annual issue, approval, stores and delivery

1. **Catalogue:** uniform items with types (shirt: long sleeve, short sleeve, golf; trousers; boots; jacket; jersey; cap ...), each with its sizes and a **price**. Admin can add, change or retire items.
2. **Site uniform list:** what a guard at each site is entitled to (for example 3 short-sleeve shirts, 2 trousers, 1 boots, 1 jacket).
3. **Annual:** the full list is available again 12 months after it was last issued.
4. **Guard orders** on the post phone from a table of his kit (item, size, issued, next due, status), ticking several items at once. Sizes come from his profile. Items not yet due need a reason.
5. **Manager or admin decides each line**, with its cost shown:
   - issue, company account;
   - issue, guard's account (he still gets it but pays: an early or lost item, or something not on his list);
   - do not issue (with a reason).
6. **Stores clerk** (new role) picks the order and marks it **ready for collection**.
7. **Supervisor gets an automatic task**: "Collect uniform for Michael and Themba at stores; deliver to Estate ABC." The task shows when each guard is next on duty, from the roster.
8. **Collection confirmed on both sides:** the supervisor marks collected; stores confirms handed over.
9. **Delivery waits for the guard's shift:** "With supervisor, deliver Tue 7 Oct". When Michael does Duty On that day, the task becomes "deliver now", and his phone says "Your uniform is with your supervisor."
10. **Guard signs for it** with his PIN. That starts his next 12 months.
11. **Guard's account items:** a separate "I agree to pay R___ for these items" signed with his PIN. The amount goes to payroll as a record only. *Legal flag (L-08):* deductions need written consent and have limits; the app never deducts.

Messages are **person to person only**: only the guard concerned, his supervisor, the manager and stores see an order. Examples: "Michael, your supervisor has your uniform and will bring it on Tuesday."

**Decided 3 Oct 2026:** no stock-holding for now. Stores marks an order ready when the items are available. A deeper stores app and stock-holding come later.

**Assumed until the owner says otherwise:**
- The old item does not have to be handed in (not recorded).
- A manager can record a new guard's starter issue, which starts his 12 months.
- Supervisors use the website on their own phone ("My tasks") first; a supervisor mode in the app comes later (D-11).

## 10. Uniform condition notes (abuse of uniform)

A supervisor can note that a guard's uniform is torn, dirty or badly kept, with a photo. This is an HR and discipline matter, so it is kept in the separate HR records (own roles, own audit trail, never on the post phone). It never triggers anything automatically. It can be referred to when a manager decides a replacement is on the guard's account.

## 11. Merchandise (later)

Company merchandise that guards can buy and be billed for, through the same order flow (guard's account, signed). Parked until after the uniform flow.

## 12. BOLO: voice notes and video

- Add a **voice note** (press and hold to record) and a **short video** to a BOLO, besides the photo and note.
- Live streaming stays planned after the pilot (D-28).
- Recordings are larger: they wait on the phone and upload when there is signal, like photos.
- *POPIA flag:* voice and video of members of the public; retention period to be set (P-3, P-5).
