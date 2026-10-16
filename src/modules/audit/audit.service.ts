import { db, type DbOrTx } from "../../config/database";
import { logger } from "../../config/logger";
import { auditLogs } from "../../db/schema";

export async function audit(
  e: { userId?: string | null; draftId?: string | null; batchId?: string | null; action: string; details?: Record<string, unknown> },
  tx: DbOrTx = db,
) {
  try {
    await tx.insert(auditLogs).values({ ...e, details: e.details ?? {} });
  } catch (err) {
    logger.warn({ err, action: e.action }, "Failed to write audit log");
  }
}
