import '../config';
import { seedDemo } from './seed';

const url = process.env.DATABASE_OWNER_URL;
if (!url) {
  console.error('Set DATABASE_OWNER_URL (see apps/api/.env.example).');
  process.exit(1);
}
seedDemo(url)
  .then((r) => {
    console.log('Demo company created. Sign in with:');
    for (const u of r.users) console.log(`  ${u.role.padEnd(16)} ${u.email}  /  ${u.password}`);
  })
  .catch((e) => {
    console.error(e.message.includes('duplicate') ? 'Demo data already exists.' : e.message);
    process.exit(1);
  });
