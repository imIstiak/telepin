import { env } from "../../config/env";
import { pinterestRequest, pinUrl } from "./client";

export interface CreatePinInput {
  accessToken: string;
  boardExternalId: string;
  title: string;
  description: string;
  altText: string;
  link?: string | null;
  imageUrl: string;
}

export interface CreatedPin {
  id: string;
  url: string;
}

export async function createPin(i: CreatePinInput): Promise<CreatedPin> {
  const body: Record<string, unknown> = {
    board_id: i.boardExternalId,
    title: i.title,
    description: i.description,
    alt_text: i.altText,
    media_source: { source_type: "image_url", url: i.imageUrl },
  };
  if (i.link) body.link = i.link;
  const res = await pinterestRequest<{ id: string }>("/pins", { method: "POST", accessToken: i.accessToken, body, timeoutMs: env.PINTEREST_WRITE_TIMEOUT_MS });
  if (!res?.id) throw new Error("Pinterest did not return a Pin id");
  return { id: res.id, url: pinUrl(res.id) };
}

interface PinListItem {
  id: string;
  title?: string | null;
  description?: string | null;
  alt_text?: string | null;
  created_at?: string;
}

/**
 * Used to reconcile PUBLISH_UNKNOWN outcomes: looks for a recently created pin on the board with the same
 * title and description. Pinterest has no idempotency key for Pin creation, so this is a best-effort match.
 */
export async function findMatchingRecentPin(
  accessToken: string,
  boardExternalId: string,
  match: { title: string; description: string; altText?: string | null; since: Date; excludePinIds?: string[] },
): Promise<CreatedPin | null> {
  const page = await pinterestRequest<{ items: PinListItem[] }>(`/boards/${encodeURIComponent(boardExternalId)}/pins`, {
    accessToken,
    query: { page_size: 50 },
  });
  const sinceMs = match.since.getTime() - 2 * 60_000;
  const exclude = new Set(match.excludePinIds ?? []);
  const hit = (page.items ?? []).find(
    (p) =>
      !exclude.has(p.id) &&
      (p.alt_text == null || !match.altText || p.alt_text.trim() === match.altText.trim()) &&
      (p.title ?? "").trim() === match.title.trim() &&
      (p.description ?? "").trim() === match.description.trim() &&
      (!p.created_at || new Date(p.created_at).getTime() >= sinceMs),
  );
  return hit ? { id: hit.id, url: pinUrl(hit.id) } : null;
}
