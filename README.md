# On Par

Measure the work. Manage the performance. Close the loop.

A workforce performance and operational-accountability platform, starting with private security companies. Built for The Security Franchise (TSF).

## Where things are

| File | What it is |
|---|---|
| [`docs/OnPar_Claude_Code_Build_Brief.md`](docs/OnPar_Claude_Code_Build_Brief.md) | The full specification (v2.1). |
| [`docs/OnPar_Prototype_Reference.html`](docs/OnPar_Prototype_Reference.html) | Clickable prototype. Download it and open it in any web browser. |
| [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md) | The build plan: technology, milestone order, the hardware spike. |
| [`docs/OPEN_DECISIONS.md`](docs/OPEN_DECISIONS.md) | Decisions waiting on the owner or a specialist. |
| [`CLAUDE.md`](CLAUDE.md) | Working rules Claude Code follows in every session. |

## Status

**Milestone 1 (foundation): built.** The management website supports sign-in, sites with shift cards, officer enrolment, post devices and the audit log. The server includes guard PIN login for devices, and company data is separated by the database itself.
Milestone 0 (the phone and kiosk test) is waiting on hardware. See [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md).

## Project layout

```
apps/api        server (NestJS + PostgreSQL)
apps/web        management website (Next.js)
packages/rules  shared business rules, used by both
docs/           brief, prototype, plan, decisions
```

## Running it locally (for developers)

Needs Node 22, pnpm 10 and PostgreSQL 16.

```bash
pnpm install
psql -U postgres -f scripts/db-setup.sql     # one time: database roles and databases
cp apps/api/.env.example apps/api/.env        # then fill in JWT_SECRET and DATA_KEY
pnpm --filter @onpar/rules build
pnpm db:migrate
pnpm db:seed                                  # demo company; prints the sign-in details
pnpm dev:api                                  # http://localhost:4000/api
pnpm dev:web                                  # http://localhost:3000
```

Run every test with `pnpm test`. The API tests use the `onpar_test` database and reset it each run.
