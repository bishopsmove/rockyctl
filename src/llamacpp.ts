import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from "undici";
import type { Provider } from "./config.js";
import type { ChatMessage, ToolDefinition, LoadedModel, GenerateResponse, ChatResponse, ModelInfo, TokenFn, RetryFn, ProgressFn, HostProvider } from "./types.js";
import { sleep, ndjsonLines } from "./utils.js";

export class LlamaCppError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "LlamaCppError";
  }
}

/**
 * Abstraction layer for model utilization.
 */
export class LlamaCppClient implements HostProvider {
  private readonly provider: Provider;
  private readonly agent: Agent;

  constructor(provider: Provider) {
    this.provider = provider;
    this.agent = new Agent({
      headersTimeout: 0,
      bodyTimeout: 0,
      connectTimeout: 10_000,
      keepAliveTimeout: 60_000,
    });
  }

  private get baseUrl(): string {
    return this.provider.baseUrl.replace(/\/+$/, "");
  }

  async listModels(timeoutMs = 5_000): Promise<ModelInfo[]> {
    const res = await this.fetch("/v1/models", { method: "GET" }, timeoutMs);
    const body = (await res.json()) as { data?: { id: string; object: string; created: number; owned_by: string }[] };
    return (body.data ?? []).map(m => ({
      name: m.id,
      size: 0
    }));
  }

  async loadedModels(timeoutMs = 5_000): Promise<LoadedModel[]> {
    // llama.cpp server /v1/models might return all available models, not just loaded ones.
    try {
      const res = await this.fetch("/v1/models", { method: "GET" }, timeoutMs);
      const body = (await res.json()) as { data?: { id: string }[] };
      return (body.data ?? []).map(m => ({
        name: m.id,
        size: 0, // llama.cpp doesn't readily provide size in /v1/models
        size_vram: 0
      }));
    } catch {
      return [];
    }
  }

  async chat(
    model: string,
    messages: ChatMessage[],
    opts: {
      tools?: ToolDefinition[];
      format?: "json" | Record<string, unknown>;
      temperature?: number;
      thinkEffort?: import("./types.js").ThinkEffort;
      onToken?: TokenFn;
      onRetry?: RetryFn;
    } = {},
  ): Promise<ChatResponse> {
    const maxAttempts = 1 + this.provider.maxRetries;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.chatOnce(model, messages, opts);
      } catch (err) {
        if (attempt >= maxAttempts) throw err;
        const delayMs = this.provider.retryBackoffMs * 2 ** (attempt - 1);
        opts.onRetry?.({ attempt, maxAttempts, delayMs, error: (err as Error).message });
        await sleep(delayMs);
      }
    }
  }

  private async chatOnce(
    model: string,
    messages: ChatMessage[],
    opts: {
      tools?: ToolDefinition[];
      format?: "json" | Record<string, unknown>;
      temperature?: number;
      thinkEffort?: import("./types.js").ThinkEffort;
      onToken?: TokenFn;
      onRetry?: RetryFn;
    },
  ): Promise<ChatResponse> {
    const body: Record<string, any> = {
      model,
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.7,
    };
    
    if (opts.tools) body.tools = opts.tools.map(t => ({
      type: "function",
      function: t.function
    }));
    if (opts.tools && opts.tools.length > 0) {
      body.tool_choice = "auto";
    }

    if (opts.format) {
      if (typeof opts.format === 'string') {
        body.response_format = { type: opts.format };
      } else {
        body.response_format = opts.format;
      }
    }

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.provider.requestTimeoutMs);

    try {
      const res = await this.fetch(
        "/v1/chat/completions",
        { method: "POST", body: JSON.stringify(body) },
        this.provider.requestTimeoutMs,
        controller,
      );
      
      if (!res.body) throw new LlamaCppError("POST /v1/chat/completions returned no body");

      const message: ChatMessage = { role: "assistant", content: "" };
      let final: any = {};
      let tokens = 0;
      let sawFirst = false;
      opts.onToken?.({ tokens: 0, elapsedMs: 0, phase: "prompt" });

      for await (const line of ndjsonLines(res.body as unknown as ReadableStream<Uint8Array>, controller.signal)) {
        let chunk: any;
        try {
          chunk = JSON.parse(line);
        } catch {
          continue;
        }
        
        if (chunk.error) throw new LlamaCppError(`Llama.cpp error: ${chunk.error}`);
        
        const delta = chunk.choices?.[0]?.delta;
        if (delta) {
          if (delta.role || delta.content) {
            if (!sawFirst) sawFirst = true;
            if (delta.content) {
              message.content += delta.content;
              tokens++;
            }
            if (delta.tool_calls) {
                message.tool_calls = [...(message.tool_calls ?? []), ...delta.tool_calls];
                tokens++;
            }
            opts.onToken?.({ tokens, elapsedMs: Date.now() - started, phase: "generate" });
          }
        }
        if (chunk.choices && chunk.choices.length > 0 && chunk.choices[0].finish_reason) {
            final = chunk;
        }
      }
      
      return {
        message: {
            ...message,
            role: "assistant"
        },
        done: true,
        done_reason: final.choices?.[0]?.finish_reason,
        total_duration: Date.now() - started
      } as ChatResponse;

    } catch (err) {
      if (controller.signal.aborted) {
        throw new LlamaCppError(`Generation with ${model} exceeded requestTimeoutMs (${this.provider.requestTimeoutMs}ms)`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async generate(
    model: string,
    prompt: string,
    opts: {
      system?: string,
      format?: "json" | Record<string, unknown>,
      temperature?: number,
      thinkEffort?: import("./types.js").ThinkEffort,
    } = {},
  ): Promise<GenerateResponse> {
    const body: Record<string, any> = {
      model,
      prompt,
      stream: false,
      temperature: opts.temperature ?? 0.7,
    };

    if (opts.system) {
        body.prompt = `${opts.system}\n\n${prompt}`;
    }
    if (opts.format) {
        if (typeof opts.format === 'string') {
            body.response_format = { type: opts.format };
        } else {
            body.response_format = opts.format;
        }
    }

    const res = await this.fetch(
      "/v1/completions",
      { method: "POST", body: JSON.stringify(body) },
      this.provider.requestTimeoutMs,
    );
    const result = (await res.json()) as any;
    
    return {
      response: result.choices?.[0]?.text ?? "",
      done: true,
      total_duration: result.usage?.total_tokens || 0
    };
  }

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
        "/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "Reply with the single word: ok" }],
            tools: [probeTool],
            stream: false,
          }),
        },
        timeoutMs,
      );
      await res.text();
      return true;
    } catch (err) {
      return false;
    }
  }

  async waitUntilReady(models: string[], progress: ProgressFn = () => {}): Promise<void> {
    const deadline = Date.now() + this.provider.readyTimeoutMs;
    const remaining = () => deadline - Date.now();

    progress(`Contacting Llama.cpp at ${this.provider.baseUrl} ...`);
    let connected = false;
    let lastErr: unknown;
    while (remaining() > 0) {
      try {
        await this.fetch("/health", { method: "GET" }, Math.min(5_000, remaining()));
        connected = true;
        break;
      } catch (err) {
        lastErr = err;
        await sleep(Math.min(2_000, Math.max(0, remaining())));
      }
    }
    if (!connected) {
      throw new LlamaCppError(
        `Llama.cpp at ${this.provider.baseUrl} did not respond within ${this.provider.readyTimeoutMs}ms` +
          ` (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`,
      );
    }
    progress(`Server up.`);
  }

  private async fetch(
    path: string,
    init: { method: string; body?: string },
    timeoutMs: number,
    controller = new AbortController(),
  ): Promise<UndiciResponse> {
    const ownTimer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await undiciFetch(this.provider.baseUrl + path, {
        method: init.method,
        body: init.body,
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        dispatcher: this.agent,
      });
      if (!res.ok) {
        throw new LlamaCppError(`${init.method} ${path} -> HTTP ${res.status}`, res.status);
      }
      return res;
    } catch (err) {
      if (controller.signal.aborted) {
        throw new LlamaCppError(`${init.method} ${path} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(ownTimer);
    }
  }
}
