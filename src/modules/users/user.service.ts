import { eq } from "drizzle-orm";
import { db } from "../../config/database";
import { env } from "../../config/env";
import { userSettings, users, type PendingAction, type User, type UserSettings } from "../../db/schema";

export function isAllowlisted(telegramUserId: string | number): boolean {
  return env.AUTHORIZED_TELEGRAM_USER_IDS.includes(String(telegramUserId));
}

export async function ensureUser(tg: { id: number; username?: string }, chatId: number | string): Promise<User> {
  const authorized = isAllowlisted(tg.id);
  const [u] = await db
    .insert(users)
    .values({
      telegramUserId: String(tg.id),
      telegramChatId: String(chatId),
      telegramUsername: tg.username ?? null,
      isAuthorized: authorized,
      timezone: env.DEFAULT_TIMEZONE,
    })
    .onConflictDoUpdate({
      target: users.telegramUserId,
      set: { telegramChatId: String(chatId), telegramUsername: tg.username ?? null, isAuthorized: authorized },
    })
    .returning();
  return u!;
}

export async function getUser(userId: string) {
  return db.query.users.findFirst({ where: eq(users.id, userId) });
}

export async function getSettings(userId: string): Promise<UserSettings> {
  const existing = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
  if (existing) return existing;
  const [created] = await db
    .insert(userSettings)
    .values({ userId, defaultBatchSize: env.DEFAULT_BATCH_SIZE, defaultIntervalMinutes: env.DEFAULT_SCHEDULE_INTERVAL_MINUTES })
    .onConflictDoNothing()
    .returning();
  return created ?? (await db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) }))!;
}

export async function updateSettings(userId: string, patch: Partial<Omit<UserSettings, "id" | "userId" | "createdAt" | "updatedAt">>) {
  await getSettings(userId);
  const [s] = await db.update(userSettings).set(patch).where(eq(userSettings.userId, userId)).returning();
  return s!;
}

export async function setPendingAction(userId: string, action: PendingAction | null) {
  await db.update(users).set({ pendingAction: action }).where(eq(users.id, userId));
}

export async function setTimezone(userId: string, tz: string) {
  await db.update(users).set({ timezone: tz }).where(eq(users.id, userId));
}
