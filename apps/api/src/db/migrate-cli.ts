import '../config';
import { migrate } from './migrate';

const url = process.env.DATABASE_OWNER_URL;
if (!url) {
  console.error('Set DATABASE_OWNER_URL (see apps/api/.env.example).');
  process.exit(1);
}
migrate(url)
  .then((applied) => console.log(applied.length ? 'Migrations complete.' : 'Database already up to date.'))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
