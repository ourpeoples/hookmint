import { z } from "zod";
import { AdError } from "../../core/errors.js";

export const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";

export interface ClaudeClientOptions {
  apiKey: string;
  /** Not read from ANTHROPIC_BASE_URL on purpose: that variable may point at some other gateway. */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ToolCall<T> {
  model: string;
  maxTokens: number;
  /** Fixed instructions only. Never put user or customer text here. */
  system: string;
  /** User and customer text goes here, as data. */
  user: string;
  toolName: string;
  toolDescription: string;
  schema: z.ZodType<T>;
}

export interface Usage {
  calls: number;
  input_tokens: number;
  output_tokens: number;
}

/**
 * Minimal Claude Messages API client. It forces one tool call whose input must match a schema, so every
 * answer is structured data that we validate again before use. No other tools are ever offered to the model.
 */
export class ClaudeClient {
  readonly usage: Usage = { calls: 0, input_tokens: 0, output_tokens: 0 };
  private apiKey: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;

  constructor(opts: ClaudeClientOptions) {
    if (!opts.apiKey) throw new Error("ClaudeClient needs an apiKey");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  async callTool<T>(call: ToolCall<T>): Promise<T> {
    const { $schema: _omit, ...inputSchema } = z.toJSONSchema(call.schema, { io: "input" }) as Record<string, unknown>;
    const body = {
      model: call.model,
      max_tokens: call.maxTokens,
      system: call.system,
      messages: [{ role: "user", content: call.user }],
      tools: [{ name: call.toolName, description: call.toolDescription, input_schema: inputSchema }],
      tool_choice: { type: "tool", name: call.toolName },
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": this.apiKey, "anthropic-version": API_VERSION, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "AbortError";
      throw new AdError("provider_unavailable", timedOut ? `The Claude API did not answer within ${this.timeoutMs / 1000}s.` : "Could not reach the Claude API.");
    } finally {
      clearTimeout(timer);
    }

    const requestId = res.headers.get("request-id") ?? undefined;
    const tag = requestId ? ` (request ${requestId})` : "";
    if (!res.ok) throw await this.httpError(res, tag);

    let json: { content?: { type: string; name?: string; input?: unknown }[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new AdError("provider_unavailable", `The Claude API returned an unreadable response${tag}.`);
    }
    this.usage.calls++;
    this.usage.input_tokens += json.usage?.input_tokens ?? 0;
    this.usage.output_tokens += json.usage?.output_tokens ?? 0;

    if (json.stop_reason === "max_tokens") throw new AdError("invalid_input", `The model's answer was cut off at ${call.maxTokens} tokens${tag}.`);
    if (json.stop_reason === "refusal") throw new AdError("invalid_input", `The model declined this request${tag}.`);
    const block = json.content?.find((b) => b.type === "tool_use" && b.name === call.toolName);
    if (!block) throw new AdError("provider_unavailable", `The model did not return the expected structured answer${tag}.`);

    const parsed = call.schema.safeParse(block.input);
    if (!parsed.success) {
      throw new AdError("invalid_input", `The model's answer did not match the expected shape${tag}: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`);
    }
    return parsed.data;
  }

  /** The API's own short explanation of a refusal (its error type and message), never our request. Empty when there is none. */
  private async detail(res: Response): Promise<string> {
    try {
      const text = (await res.text()).slice(0, 4096);
      const e = (JSON.parse(text) as { error?: { type?: unknown; message?: unknown } }).error;
      const type = typeof e?.type === "string" ? e.type.replace(/[^a-z_]/g, "").slice(0, 40) : "";
      const message = typeof e?.message === "string" ? e.message.replace(/\s+/g, " ").replace(/sk-[A-Za-z0-9_-]{8,}/g, "[key]").slice(0, 300) : "";
      return type || message ? `: ${[type, message].filter(Boolean).join(": ")}` : "";
    } catch {
      return "";
    }
  }

  /** Error messages carry the status, the request id and the API's own error type and short message. Never our request body, and never the key. */
  private async httpError(res: Response, tag: string): Promise<AdError> {
    const s = res.status;
    if (s === 401 || s === 403) return new AdError("forbidden", `The Claude API rejected the API key${tag}. Check ANTHROPIC_API_KEY.`);
    if (s === 429) {
      const retry = Number(res.headers.get("retry-after"));
      return new AdError("rate_limited", `The Claude API rate limit was hit${tag}.`, Number.isFinite(retry) && retry > 0 ? retry : undefined);
    }
    if (s === 404) return new AdError("invalid_input", `The Claude API does not know this model${tag}. Check HOOKMINT_MODEL.${await this.detail(res)}`);
    if (s === 400 || s === 413 || s === 422) return new AdError("invalid_input", `The Claude API rejected the request${tag} (status ${s})${await this.detail(res)}`);
    return new AdError("provider_unavailable", `The Claude API is unavailable${tag} (status ${s}).`);
  }
}
