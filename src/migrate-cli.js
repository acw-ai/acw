// npm run migrate  — applies any new files in migrations/<driver>/ and exits.
import { config } from './config.js';
import { openExecutor, migrate } from './db.js';

const exec = await openExecutor(config.db);
try {
  await migrate(exec, console);
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await exec.close();
}
