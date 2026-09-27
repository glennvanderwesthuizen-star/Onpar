# On Par: running it safely

For whoever hosts On Par. Written at Milestone 10 (hardening).

## Settings that matter for security

| Setting | Production value |
|---|---|
| `JWT_SECRET` | 48+ random characters (`openssl rand -base64 48`). Changing it signs everyone out. |
| `DATA_KEY` | 32 random bytes, base64. Encrypts ID numbers and every stored file. **If it is lost, those cannot be read, backups included.** Keep two copies, held by two people, apart from the backups. |
| `COOKIE_SECURE` | `true` (the site must be served over HTTPS). |
| `TRUST_PROXY` | The load balancer's address range, so sign-in throttling sees real visitor addresses. |
| `STORAGE_DRIVER` | `s3`, with `S3_BUCKET`, `S3_REGION=af-south-1` and ideally `S3_KMS_KEY_ID`. Turn on bucket versioning, and block public access. |
| `WEB_ORIGIN` | The website's own address. |

Secrets live in the host's secret store (for example AWS Secrets Manager), never in the code or on a laptop.

## Creating a company

```
pnpm --filter @onpar/api company:create "Company name" "Admin full name" admin@company.co.za
```

This prints a temporary password once. Give it to the administrator privately (in person or by phone). They must choose their own password at first sign-in, and they then add the other users on the **Users** page.

## Backups

- **In production:** use the database host's automated backups with point-in-time recovery (for example RDS, 35 days), in the Cape Town region. S3 versioning protects the files.
- **Portable backup, as well:** run `scripts/backup.sh` every night (it needs `DATABASE_OWNER_URL` and `BACKUP_PASSPHRASE_FILE`). It writes one encrypted file with a checksum. Keep copies in a second place within South Africa.
- **Test the restore every month.** This is a tested recovery process, as brief section 9 requires. Run `scripts/restore.sh <file>` into a **new, empty** database with `TARGET_DATABASE_URL` and `TARGET_UPLOAD_DIR`. It refuses a damaged file, a wrong passphrase or a database that is not empty, and finishes only when every table's row count matches. Then sign in to the restored copy and open an officer's photo.
- The same backup-and-restore run is also an automated test (`apps/api/test/backup.test.ts`) that runs on every change.

Proposed targets (to confirm): lose at most **1 day** of data with the nightly portable backup (minutes with point-in-time recovery), and be back within **4 hours**.

## Scheduled jobs (run inside the server)

| Job | How often | What it does |
|---|---|---|
| Tasks | every 5 minutes | Creates recurring task occurrences, marks missed ones. |
| Patrols | every minute | Overdue alerts, escalation to the control room, missed windows. |
| Retention | once a day | Removes selfies and patrol photos past their period, **only if the company has switched it on**. |

Run **one** server instance for the pilot. Before running several, move these jobs to a single scheduled worker.

## Before each release

- `pnpm audit --prod` shows no known vulnerabilities.
- All automated tests pass (GitHub runs them on every change).
- Migrations are applied with `pnpm db:migrate` using the owner role; the app itself uses the restricted role.
