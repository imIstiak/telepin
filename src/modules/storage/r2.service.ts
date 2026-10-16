import fs from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "../../config/env";

export interface StoredObject {
  objectKey: string;
  publicUrl: string;
}

export interface StorageService {
  readonly driver: "r2" | "local";
  put(objectKey: string, body: Buffer, contentType: string, opts?: { immutable?: boolean }): Promise<StoredObject>;
  get(objectKey: string): Promise<Buffer>;
  delete(objectKey: string): Promise<void>;
  publicUrl(objectKey: string): string;
}

/** Object key layout: pinterest-agent/users/{userId}/batches/{batchId}/pin-{draftId}/{kind}-v{version}-{rand}.{ext} */
export function buildObjectKey(p: { userId: string; batchId: string; draftId: string; kind: "background" | "final"; version: number; ext: string }) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `pinterest-agent/users/${p.userId}/batches/${p.batchId}/pin-${p.draftId}/${p.kind}-v${p.version}-${rand}.${p.ext}`;
}

export class R2StorageService implements StorageService {
  readonly driver = "r2" as const;
  private client: S3Client;
  constructor() {
    if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET_NAME || !env.R2_PUBLIC_BASE_URL) {
      throw new Error("Cloudflare R2 is not fully configured (R2_* variables)");
    }
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
    });
  }

  publicUrl(objectKey: string) {
    return `${env.R2_PUBLIC_BASE_URL.replace(/\/$/, "")}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
  }

  async put(objectKey: string, body: Buffer, contentType: string, opts: { immutable?: boolean } = {}): Promise<StoredObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: env.R2_BUCKET_NAME,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
        // Keys are unique per version, so content never changes under a key.
        CacheControl: opts.immutable === false ? "public, max-age=300" : "public, max-age=31536000, immutable",
      }),
    );
    return { objectKey, publicUrl: this.publicUrl(objectKey) };
  }

  async get(objectKey: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: objectKey }));
    if (!res.Body) throw new Error(`R2 object ${objectKey} has no body`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async delete(objectKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: objectKey }));
  }
}

/** Development/test only: files on disk, served by the API at /media/*. Pinterest cannot fetch these. */
export class LocalStorageService implements StorageService {
  readonly driver = "local" as const;
  constructor(private root = path.resolve(env.LOCAL_STORAGE_DIR)) {}
  private file(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error("Invalid object key");
    return p;
  }
  publicUrl(objectKey: string) {
    return `${env.APP_BASE_URL.replace(/\/$/, "")}/media/${objectKey}`;
  }
  async put(objectKey: string, body: Buffer): Promise<StoredObject> {
    const f = this.file(objectKey);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, body);
    return { objectKey, publicUrl: this.publicUrl(objectKey) };
  }
  async get(objectKey: string) {
    return fs.readFile(this.file(objectKey));
  }
  async delete(objectKey: string) {
    await fs.rm(this.file(objectKey), { force: true });
  }
}

let instance: StorageService | undefined;
export function getStorage(): StorageService {
  if (!instance) instance = env.STORAGE_DRIVER === "local" ? new LocalStorageService() : new R2StorageService();
  return instance;
}
export function setStorage(s: StorageService) {
  instance = s;
}
