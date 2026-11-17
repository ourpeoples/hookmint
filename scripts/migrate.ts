/**
 * Applies database migrations. Run it as a database user that can create tables (not hookmint_app).
 *
 *   HOOKMINT_DATABASE_ADMIN_URL=postgres://owner:...@host/hookmint npm run db:migrate
 */
import { migrate } from "../src/db/migrate.js";

const url = process.env.HOOKMINT_DATABASE_ADMIN_URL?.trim();
if (!url) {
  console.error("Set HOOKMINT_DATABASE_ADMIN_URL to a connection string for a user that owns the database.");
  process.exit(2);
}
try {
  const applied = await migrate(url, { log: (l) => console.log(l) });
  console.log(applied.length ? `${applied.length} migration(s) applied.` : "Database is up to date.");
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
