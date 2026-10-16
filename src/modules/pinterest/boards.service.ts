import { and, asc, eq, notInArray } from "drizzle-orm";
import { db } from "../../config/database";
import { pinterestBoards, type PinterestBoard } from "../../db/schema";
import { pinterestRequest } from "./client";
import { errMessage, logger } from "../../config/logger";
import { getAccount, getValidAccessToken } from "./oauth.service";

interface BoardsPage {
  items: { id: string; name: string; description?: string | null; privacy?: string }[];
  bookmark?: string | null;
}

/** Fetches every board (following bookmarks) and upserts them; boards no longer returned are deactivated. */
export async function syncBoards(userId: string): Promise<PinterestBoard[]> {
  const { token, account } = await getValidAccessToken(userId);
  const seen: string[] = [];
  let bookmark: string | undefined;
  let pages = 0;
  do {
    const page = await pinterestRequest<BoardsPage>("/boards", { accessToken: token, query: { page_size: 100, bookmark } });
    for (const b of page.items ?? []) {
      seen.push(b.id);
      await db
        .insert(pinterestBoards)
        .values({
          pinterestAccountId: account.id,
          externalBoardId: b.id,
          name: b.name,
          description: b.description ?? null,
          privacy: b.privacy ?? null,
          isActive: true,
          lastSyncedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [pinterestBoards.pinterestAccountId, pinterestBoards.externalBoardId],
          set: { name: b.name, description: b.description ?? null, privacy: b.privacy ?? null, isActive: true, lastSyncedAt: new Date() },
        });
    }
    bookmark = page.bookmark ?? undefined;
    pages++;
  } while (bookmark && pages < 50);

  const deactivate = db.update(pinterestBoards).set({ isActive: false });
  if (seen.length) await deactivate.where(and(eq(pinterestBoards.pinterestAccountId, account.id), notInArray(pinterestBoards.externalBoardId, seen)));
  else await deactivate.where(eq(pinterestBoards.pinterestAccountId, account.id));
  return listBoards(userId);
}

export async function listBoards(userId: string): Promise<PinterestBoard[]> {
  const acc = await getAccount(userId);
  if (!acc) return [];
  return db
    .select()
    .from(pinterestBoards)
    .where(and(eq(pinterestBoards.pinterestAccountId, acc.id), eq(pinterestBoards.isActive, true)))
    .orderBy(asc(pinterestBoards.name));
}

/** Loads a board only if it belongs to the user's connected account and is active. */
export async function getOwnedBoard(userId: string, boardId: string): Promise<PinterestBoard | null> {
  const acc = await getAccount(userId);
  if (!acc) return null;
  const b = await db.query.pinterestBoards.findFirst({
    where: and(eq(pinterestBoards.id, boardId), eq(pinterestBoards.pinterestAccountId, acc.id), eq(pinterestBoards.isActive, true)),
  });
  return b ?? null;
}

/** Boards Pins can be published to. Secret boards are allowed by the API; archived ones are not returned. */
export function isPublishable(b: PinterestBoard) {
  return b.isActive;
}

/** Cached boards, re-synced from Pinterest when empty or older than an hour. */
export async function ensureBoards(userId: string): Promise<PinterestBoard[]> {
  let boards = await listBoards(userId);
  const stale = boards.length === 0 || boards.some((b) => Date.now() - b.lastSyncedAt.getTime() > 60 * 60_000);
  if (stale && (await getAccount(userId))?.connectionStatus === "CONNECTED") {
    try {
      boards = await syncBoards(userId);
    } catch (e) {
      logger.warn({ err: errMessage(e) }, "Board sync failed; using cached boards");
    }
  }
  return boards;
}
