import '../config';
import { createCompany } from './company';

// Usage: pnpm --filter @onpar/api company:create "Company name" "Admin full name" admin@example.co.za
const [name, adminName, adminEmail] = process.argv.slice(2);
const url = process.env.DATABASE_OWNER_URL;
if (!url || !name || !adminName || !adminEmail) {
  console.error('Usage: pnpm company:create "Company name" "Admin full name" admin@example.co.za   (needs DATABASE_OWNER_URL)');
  process.exit(1);
}
createCompany(url, { name, adminName, adminEmail })
  .then((r) => {
    console.log(`Company created. Give the administrator these sign-in details privately:`);
    console.log(`  Email:              ${r.email}`);
    console.log(`  Temporary password: ${r.password}`);
    console.log('They must choose their own password when they first sign in.');
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
