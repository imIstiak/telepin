import { sql } from "drizzle-orm";
import { db } from "../../src/config/database";
import { runMigrations } from "../../src/db/migrate";

let migrated = false;
export async function setupDb() {
  if (!migrated) {
    await runMigrations();
    migrated = true;
  }
  await db.execute(
    sql`TRUNCATE audit_logs, publish_jobs, pin_schedules, image_assets, pin_drafts, pin_batches, oauth_states, pinterest_boards, pinterest_accounts, user_settings, users RESTART IDENTITY CASCADE`,
  );
}
