import type { ZodType } from "zod";

export type AITask = "quotes" | "rewrite_quote" | "seo" | "board_scores";

export interface JsonGenerationRequest<T> {
  /** Logical task name (used for logging and by the mock provider). */
  task: AITask;
  /** Structured inputs, mirrored in the prompt (used by the mock provider). */
  input?: Record<string, unknown>;
  system: string;
  prompt: string;
  schema: ZodType<T>;
  temperature?: number;
}

export interface TextProvider {
  readonly name: string;
  /** Generates JSON and validates it against the schema. Throws AIOutputError if it cannot. */
  generateJson<T>(req: JsonGenerationRequest<T>): Promise<T>;
  /** Optional: embeddings for semantic duplicate detection. */
  embed?(texts: string[]): Promise<number[][]>;
}

export interface ImageProvider {
  readonly name: string;
  /** Returns a raster image buffer (any common format). Must not contain text. */
  generateBackground(prompt: string, opts: { seed?: number; style: string }): Promise<Buffer>;
}

export class AIOutputError extends Error {
  constructor(
    message: string,
    readonly raw?: string,
  ) {
    super(message);
  }
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}
