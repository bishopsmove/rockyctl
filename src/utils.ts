import type { ChatMessage } from "./types.js";

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function* ndjsonLines(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal.aborted) throw new Error("aborted");
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) yield line;
        idx = buffer.indexOf("\n");
      }
    }
    const rest = buffer.trim();
    if (rest) yield rest;
  } finally {
    reader.releaseLock();
  }
}

export function describeError(err: unknown): string {
    if (!(err instanceof Error)) return String(err);
    const parts: string[] = [err.message];
    let current: any = err.cause;
    let depth = 0;
    while (current && typeof current === 'object' && depth < 4) {
        if (current.code) parts.push(`[${current.code}] ${current.message}`);
        else parts.push(current.message);
        current = current.cause;
        depth++;
    }
    return parts.join(" <- ");
}

export const RETRYABLE_PATTERN =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ECONNABORTED|EAI_AGAIN|ENOTFOUND|UND_ERR_SOCKET|socket hang up|other side closed|ended without a final chunk/i;

export function isRetryableError(err: unknown): boolean {
  const errWithStatus = err as { status?: number };
  if (errWithStatus.status !== undefined && errWithStatus.status >= 500) return true;
  if (err instanceof Error && RETRYABLE_PATTERN.test(err.message)) return true;
  return false;
}
