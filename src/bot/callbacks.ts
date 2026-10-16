/**
 * Compact callback payloads. Telegram limits callback_data to 64 bytes, so UUIDs are encoded as 22-char
 * base64url and the payload is "<action>:<arg>:<arg>...". Full state always lives in PostgreSQL.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function shortId(uuid: string): string {
  if (!UUID_RE.test(uuid)) throw new Error(`Not a UUID: ${uuid}`);
  return Buffer.from(uuid.replace(/-/g, ""), "hex").toString("base64url");
}

export function longId(s: string): string | null {
  if (!/^[A-Za-z0-9_-]{22}$/.test(s)) return null;
  const hex = Buffer.from(s, "base64url").toString("hex");
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function cb(action: string, ...args: (string | number)[]): string {
  const data = [action, ...args.map((a) => (typeof a === "string" && UUID_RE.test(a) ? shortId(a) : String(a)))].join(":");
  if (Buffer.byteLength(data) > 64) throw new Error(`callback_data too long (${data.length}): ${action}`);
  return data;
}

export interface ParsedCallback {
  action: string;
  args: string[];
  /** Decode the arg at index i as a UUID (null if malformed). */
  id(i: number): string | null;
  int(i: number): number | null;
}

export function parseCallback(data: string | undefined): ParsedCallback | null {
  if (!data || data.length > 64) return null;
  const [action, ...args] = data.split(":");
  if (!action || !/^[a-z]{1,8}$/.test(action)) return null;
  return {
    action,
    args,
    id: (i) => (args[i] ? longId(args[i]!) : null),
    int: (i) => {
      const v = args[i];
      return v !== undefined && /^-?\d{1,9}$/.test(v) ? Number(v) : null;
    },
  };
}
