import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { AIOutputError, AIProviderError, type ImageProvider, type JsonGenerationRequest, type TextProvider } from "./provider.interface";

function classify(e: unknown): AIProviderError {
  const msg = e instanceof Error ? e.message : String(e);
  const status = (e as { status?: number })?.status;
  const retryable = status === undefined || status === 429 || status >= 500 || /timeout|ECONNRESET|fetch failed/i.test(msg);
  return new AIProviderError(`Gemini request failed${status ? ` (${status})` : ""}: ${msg.slice(0, 300)}`, retryable);
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  return JSON.parse(trimmed);
}

export class GeminiTextProvider implements TextProvider {
  readonly name = "gemini";
  private client: GoogleGenAI;
  constructor(
    apiKey = env.AI_TEXT_API_KEY,
    private model = env.AI_TEXT_MODEL,
    private embeddingModel = env.AI_EMBEDDING_MODEL,
  ) {
    if (!apiKey) throw new Error("AI_TEXT_API_KEY is not configured");
    this.client = new GoogleGenAI({ apiKey });
  }

  async generateJson<T>(req: JsonGenerationRequest<T>): Promise<T> {
    const jsonSchema = z.toJSONSchema(req.schema, { target: "draft-7", unrepresentable: "any" });
    let prompt = req.prompt;
    let lastRaw = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      let text: string | undefined;
      try {
        const res = await this.client.models.generateContent({
          model: this.model,
          contents: prompt,
          config: {
            systemInstruction: req.system,
            responseMimeType: "application/json",
            responseJsonSchema: jsonSchema,
            temperature: req.temperature ?? 0.9,
          },
        });
        text = res.text;
      } catch (e) {
        throw classify(e);
      }
      lastRaw = text ?? "";
      if (!text) {
        if (attempt === 2) throw new AIOutputError("Empty response from model (possibly blocked by safety filters)");
        continue;
      }
      let parsed: unknown;
      try {
        parsed = extractJson(text);
      } catch {
        prompt = `${req.prompt}\n\nYour previous reply was not valid JSON. Reply with JSON only.`;
        continue;
      }
      const result = req.schema.safeParse(parsed);
      if (result.success) return result.data;
      logger.warn({ issues: result.error.issues.slice(0, 5) }, "AI JSON failed validation, retrying");
      prompt = `${req.prompt}\n\nYour previous JSON failed validation: ${JSON.stringify(result.error.issues.slice(0, 5))}. Fix it and reply with JSON only.`;
    }
    throw new AIOutputError("Model output failed schema validation", lastRaw.slice(0, 2000));
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    try {
      const res = await this.client.models.embedContent({ model: this.embeddingModel, contents: texts });
      return (res.embeddings ?? []).map((e) => e.values ?? []);
    } catch (e) {
      throw classify(e);
    }
  }
}

export class GeminiImageProvider implements ImageProvider {
  readonly name = "gemini";
  private client: GoogleGenAI;
  constructor(
    apiKey = env.AI_IMAGE_API_KEY || env.AI_TEXT_API_KEY,
    private model = env.AI_IMAGE_MODEL,
  ) {
    if (!apiKey) throw new Error("AI_IMAGE_API_KEY is not configured");
    this.client = new GoogleGenAI({ apiKey });
  }

  async generateBackground(prompt: string): Promise<Buffer> {
    try {
      if (this.model.startsWith("imagen")) {
        const res = await this.client.models.generateImages({
          model: this.model,
          prompt,
          // Imagen has no 2:3 option; 3:4 is center-cropped to 2:3 by the renderer.
          config: { numberOfImages: 1, aspectRatio: "3:4", includeRaiReason: true },
        });
        const img = res.generatedImages?.[0];
        const bytes = img?.image?.imageBytes;
        if (!bytes) throw new AIProviderError(`Imagen returned no image${img?.raiFilteredReason ? `: ${img.raiFilteredReason}` : ""}`, false);
        return Buffer.from(bytes, "base64");
      }
      const res = await this.client.models.generateContent({
        model: this.model,
        contents: prompt,
        config: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "2:3" } },
      });
      const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (!part?.inlineData?.data) throw new AIProviderError("Image model returned no image data", false);
      return Buffer.from(part.inlineData.data, "base64");
    } catch (e) {
      if (e instanceof AIProviderError) throw e;
      throw classify(e);
    }
  }
}
