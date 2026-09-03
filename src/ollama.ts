import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from "undici";
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
  done_reason?: string;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  total_duration?: number;
}

export interface ModelInfo {
  name: string;
  size: number;
}

/** From /api/ps — what is currently loaded and where. */
export interface LoadedModel {
  name: string;
  size: number;
  size_vram: number;
  expires_at?: string;
  context_length?: number;
}

export type ProgressFn = (message: string) => void;

/** Called as tokens stream in; `tokens` is the running count for this response. */
export type TokenFn = (info: { tokens: number; elapsedMs: number; phase: "prompt" | "generate" }) => void;

export class OllamaError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "OllamaError";
  }
}

export class OllamaClient {
  private readonly baseUrl: string;
  private readonly agent: Agent;

  constructor(private readonly settings: Settings["ollama"]) {
    this.baseUrl = settings.baseUrl.replace(/\/+$/, "");
    // undici's defaults (headersTimeout/bodyTimeout = 300s) are what produce a bare
    // "fetch failed" on a slow local model: with stream:false Ollama sends nothing until
    // generation finishes. We manage the deadline ourselves via AbortController instead.
    this.agent = new Agent({
      headersTimeout: 0,
      bodyTimeout: 0,
      connectTimeout: 10_000,
      keepAliveTimeout: 60_000,
    });
  }

  /** Cheap reachability probe. Resolves to the model list, rejects if the server is down. */
  async listModels(timeoutMs = 5_000): Promise<ModelInfo[]> {
    const res = await this.fetch("/api/tags", { method: "GET" }, timeoutMs);
    const body = (await res.json()) as { models?: ModelInfo[] };
    return body.models ?? [];
  }

  /** What is loaded right now, with VRAM residency. */
  async loadedModels(timeoutMs = 5_000): Promise<LoadedModel[]> {
    const res = await this.fetch("/api/ps", { method: "GET" }, timeoutMs);
    const body = (await res.json()) as { models?: LoadedModel[] };
    return body.models ?? [];
  }

  /**
   * Loads a model into memory without generating anything. Ollama treats a chat request
   * with an empty message list as a load request. This is the slow part of readiness.
   */
  async warmUp(model: string, timeoutMs: number): Promise<void> {
    const res = await this.fetch(
      "/api/chat",
      {
        method: "POST",
        // Passing num_ctx here matters: Ollama reloads a model whose loaded context size
        // differs from the request, so warming with the wrong ctx just moves the wait.
        body: JSON.stringify({
          model,
          messages: [],
          keep_alive: this.settings.keepAlive,
          options: { num_ctx: this.settings.numCtx },
        }),
      },
      timeoutMs,
    );
    await res.text();
  }

  /**
   * Streaming chat. Streaming matters for two reasons: Ollama sends headers immediately, so
   * no intermediary can mistake a long generation for a dead connection, and we can show
   * progress on a slow local model. Content and tool_calls are accumulated into one message.
   */
  async chat(
    model: string,
    messages: ChatMessage[],
    opts: {
      tools?: ToolDefinition[];
      format?: "json" | Record<string, unknown>;
      temperature?: number;
      onToken?: TokenFn;
    } = {},
  ): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      keep_alive: this.settings.keepAlive,
      options: {
        num_ctx: this.settings.numCtx,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      },
    };
    if (opts.tools?.length) body.tools = opts.tools;
    if (opts.format) body.format = opts.format;

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.requestTimeoutMs);
    try {
      const res = await this.fetch(
        "/api/chat",
        { method: "POST", body: JSON.stringify(body) },
        this.settings.requestTimeoutMs,
        controller,
      );
      if (!res.body) throw new OllamaError("POST /api/chat returned no body");

      const message: ChatMessage = { role: "assistant", content: "" };
      let final: Partial<ChatResponse> = {};
      let tokens = 0;
      let sawFirst = false;
      opts.onToken?.({ tokens: 0, elapsedMs: 0, phase: "prompt" });

      for await (const line of ndjsonLines(res.body as unknown as ReadableStream<Uint8Array>, controller.signal)) {
        let chunk: Partial<ChatResponse> & { error?: string };
        try {
          chunk = JSON.parse(line);
        } catch {
          continue;
        }
        if (chunk.error) throw new OllamaError(`Ollama error during generation: ${chunk.error}`);
        const m = chunk.message;
        if (m) {
          if (!sawFirst) sawFirst = true;
          if (m.content) {
            message.content += m.content;
            tokens++;
          }
          if (m.tool_calls?.length) {
            message.tool_calls = [...(message.tool_calls ?? []), ...m.tool_calls];
            tokens++;
          }
          opts.onToken?.({ tokens, elapsedMs: Date.now() - started, phase: "generate" });
        }
        if (chunk.done) final = chunk;
      }
      if (!final.done) {
        throw new OllamaError(`Stream from ${model} ended without a final chunk (connection dropped?)`);
      }
      return { ...(final as ChatResponse), message, done: true };
    } catch (err) {
      if (controller.signal.aborted) {
        throw new OllamaError(`Generation with ${model} exceeded requestTimeoutMs (${this.settings.requestTimeoutMs}ms)`);
      }
      if (err instanceof OllamaError) throw err;
      throw new OllamaError(`Streaming from ${model} failed: ${describeError(err)}`);
    } finally {
      clearTimeout(timer);
    }
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
      const res = await this.fetch(
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
      await res.text();
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
        throw new OllamaError(`Failed to load ${model}: ${describeError(err)}`);
      }
      progress(`${model} ready (${((Date.now() - started) / 1000).toFixed(1)}s).`);
    }
  }

  private async fetch(
    path: string,
    init: { method: string; body?: string },
    timeoutMs: number,
    controller = new AbortController(),
  ): Promise<UndiciResponse> {
    // For non-streaming calls the timer covers the whole request. For streaming calls the
    // caller owns the controller and clears its own timer after the body is consumed.
    const ownTimer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await undiciFetch(this.baseUrl + path, {
        method: init.method,
        body: init.body,
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        dispatcher: this.agent,
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
      if (controller.signal.aborted) {
        throw new OllamaError(`${init.method} ${path} timed out after ${timeoutMs}ms`);
      }
      throw new OllamaError(`${init.method} ${path} failed: ${describeError(err)}`);
    } finally {
      // Streaming callers pass their own controller and keep their own timer; we only
      // clear ours here, which is harmless for them because their timer is separate.
      clearTimeout(ownTimer);
    }
  }
}

/** Splits a byte stream into newline-delimited JSON lines. */
async function* ndjsonLines(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal.aborted) throw new Error("aborted");
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) yield line;
      }
    }
    const rest = buffer.trim();
    if (rest) yield rest;
  } finally {
    reader.releaseLock();
  }
}

/** Unwraps undici's "fetch failed" so the real cause (ECONNRESET, ECONNREFUSED, ...) is visible. */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.message];
  let cause: unknown = (err as { cause?: unknown }).cause;
  let depth = 0;
  while (cause instanceof Error && depth++ < 4) {
    const code = (cause as { code?: string }).code;
    parts.push(`${code ? `[${code}] ` : ""}${cause.message}`);
    cause = (cause as { cause?: unknown }).cause;
  }
  return parts.join(" <- ");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
