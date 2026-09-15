import type { Provider, ThinkEffort } from "./config.js";

export type { ThinkEffort };

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

export interface GenerateResponse {
  response: string;
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  total_duration?: number;
  error?: string;
}

export interface ModelInfo {
  name: string;
  size: number;
}

/** What is loaded right now, with VRAM residency. */
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

/** Called before each retry sleep, once a chat() attempt has failed with a transient error. */
export type RetryFn = (info: { attempt: number; maxAttempts: number; delayMs: number; error: string }) => void;

/**
 * Abstraction layer for model utilization.
 */
export interface HostProvider {
  waitUntilReady(models: string[], progress: ProgressFn): Promise<void>;
  chat(
    model: string,
    messages: ChatMessage[],
    opts: {
      tools?: ToolDefinition[];
      format?: "json" | Record<string, unknown>;
      temperature?: number;
      thinkEffort?: ThinkEffort;
      onToken?: TokenFn;
      onRetry?: RetryFn;
    },
  ): Promise<ChatResponse>;
  generate(
    model: string,
    prompt: string,
    opts: {
      system?: string;
      format?: "json" | Record<string, unknown>;
      temperature?: number;
      thinkEffort?: ThinkEffort;
    },
  ): Promise<GenerateResponse>;
  loadedModels(timeoutMs?: number): Promise<LoadedModel[]>;
  supportsTools(model: string, timeoutMs: number): Promise<boolean>;
}
