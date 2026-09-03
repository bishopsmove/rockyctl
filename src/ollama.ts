import type { Settings } from "./config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatResponse {
  message: ChatMessage;
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

export interface ModelInfo {
  name: string;
  size: number;
}

export type ProgressFn = (message: string) => void;

export class OllamaError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "OllamaError";
  }
}

export class OllamaClient {
  private readonly baseUrl: string;

  constructor(private readonly settings: Settings["ollama"]) {
    this.baseUrl = settings.baseUrl.replace(/\/+$/, "");
  }

  /** Cheap reachability probe. Resolves to the model list, rejects if the server is down. */
  async listModels(timeoutMs = 5_000): Promise<ModelInfo[]> {
    const res = await this.fetch("/api/tags", { method: "GET" }, timeoutMs);
    const body = (await res.json()) as { models?: ModelInfo[] };
    return body.models ?? [];
  }

  /**
   * Loads a model into memory without generating anything. Ollama treats a chat request
   * with an empty message list as a load request. This is the slow part of readiness.
   */
  async warmUp(model: string, timeoutMs: number): Promise<void> {
    await this.fetch(
      "/api/chat",
      {
        method: "POST",
        body: JSON.stringify({ model, messages: [], keep_alive: this.settings.keepAlive }),
      },
      timeoutMs,
    );
  }

  async chat(
    model: string,
    messages: ChatMessage[],
    opts: { tools?: ToolDefinition[]; format?: "json" | Record<string, unknown>; temperature?: number } = {},
  ): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
      keep_alive: this.settings.keepAlive,
      options: {
        num_ctx: this.settings.numCtx,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      },
    };
    if (opts.tools?.length) body.tools = opts.tools;
    if (opts.format) body.format = opts.format;

    const res = await this.fetch(
      "/api/chat",
      { method: "POST", body: JSON.stringify(body) },
      this.settings.requestTimeoutMs,
    );
    return (await res.json()) as ChatResponse;
  }

  /**
   * Probes whether a model accepts the `tools` parameter. Ollama returns HTTP 400 with
   * "does not support tools" for models whose template lacks tool support.
   */
  async supportsTools(model: string, timeoutMs: number): Promise<boolean> {
    const probeTool: ToolDefinition = {
      type: "function",
      function: {
        name: "noop",
        description: "Does nothing.",
        parameters: { type: "object", properties: {} },
      },
    };
    try {
      await this.fetch(
        "/api/chat",
        {
          method: "POST",
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "Reply with the single word: ok" }],
            tools: [probeTool],
            stream: false,
            keep_alive: this.settings.keepAlive,
            options: { num_predict: 8 },
          }),
        },
        timeoutMs,
      );
      return true;
    } catch (err) {
      if (err instanceof OllamaError && err.status === 400 && /tools/i.test(err.message)) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Full readiness sequence under a single deadline:
   *   1. poll /api/tags until the server answers
   *   2. confirm every required model is pulled
   *   3. warm each model into memory
   * Throws with a specific message on whichever stage fails or times out.
   */
  async waitUntilReady(models: string[], progress: ProgressFn = () => {}): Promise<void> {
    const deadline = Date.now() + this.settings.readyTimeoutMs;
    const remaining = () => deadline - Date.now();

    progress(`Contacting Ollama at ${this.baseUrl} ...`);
    let available: ModelInfo[] | undefined;
    let lastErr: unknown;
    while (remaining() > 0) {
      try {
        available = await this.listModels(Math.min(5_000, remaining()));
        break;
      } catch (err) {
        lastErr = err;
        await sleep(Math.min(2_000, Math.max(0, remaining())));
      }
    }
    if (!available) {
      throw new OllamaError(
        `Ollama at ${this.baseUrl} did not respond within ${this.settings.readyTimeoutMs}ms` +
          (lastErr instanceof Error ? ` (${lastErr.message})` : ""),
      );
    }
    progress(`Server up. ${available.length} model(s) installed.`);

    const names = new Set(available.map((m) => m.name));
    const missing = [...new Set(models)].filter((m) => !names.has(m) && !names.has(`${m}:latest`));
    if (missing.length) {
      throw new OllamaError(
        `Model(s) not installed on ${this.baseUrl}: ${missing.join(", ")}\n` +
          `Run: ${missing.map((m) => `ollama pull ${m}`).join(" && ")}`,
      );
    }

    for (const model of [...new Set(models)]) {
      if (remaining() <= 0) {
        throw new OllamaError(`Timed out before warming ${model} (readyTimeoutMs=${this.settings.readyTimeoutMs})`);
      }
      progress(`Loading ${model} into memory ...`);
      const started = Date.now();
      try {
        await this.warmUp(model, remaining());
      } catch (err) {
        throw new OllamaError(
          `Failed to load ${model}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      progress(`${model} ready (${((Date.now() - started) / 1000).toFixed(1)}s).`);
    }
  }

  private async fetch(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
        signal: controller.signal,
      });
      if (!res.ok) {
        let detail = "";
        try {
          const j = (await res.json()) as { error?: string };
          detail = j.error ?? "";
        } catch {
          /* ignore */
        }
        throw new OllamaError(`${init.method} ${path} -> HTTP ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
      }
      return res;
    } catch (err) {
      if (err instanceof OllamaError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new OllamaError(`${init.method} ${path} timed out after ${timeoutMs}ms`);
      }
      throw new OllamaError(`${init.method} ${path} failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
