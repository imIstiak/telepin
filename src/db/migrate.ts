import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDatabase, db } from "../config/database";
import { logger } from "../config/logger";

export async function runMigrations() {
  // Works both from src/ (tsx) and dist/ (compiled): drizzle/ lives at the repo root.
  const migrationsFolder = path.resolve(__dirname, "..", "..", "drizzle");
  await migrate(db, { migrationsFolder });
  logger.info({ migrationsFolder }, "Database migrations applied");
}

if (require.main === module) {
  runMigrations()
    .then(() => closeDatabase())
    .catch(async (e) => {
      logger.error({ err: e }, "Migration failed");
      await closeDatabase();
      process.exit(1);
    });
}
