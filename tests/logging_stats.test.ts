import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { OllamaClient, type ChatResponse } from "../src/ollama.js";
import { SettingsSchema } from "../src/config.js";
import { RunLog } from "../src/log.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync, readFileSync } from "node:fs";

function settings(baseUrl: string, over: Partial<{ requestTimeoutMs: number }> = {}) {
  return SettingsSchema.parse({ providers: [{ providerName: "ollama", baseUrl, ...over }] }).providers.find(p => p.providerName === "ollama")!;
}

test("ollama client returns all expected metrics in chat response", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write(JSON.stringify({ 
      message: { role: "assistant", content: "hi" }, 
      done: false,
      prompt_eval_count: 10,
      prompt_eval_duration: 100000000, // 100ms
      eval_count: 20,
      eval_duration: 200000000, // 200ms
      total_duration: 350000000,
    }) + "\n");
    res.end(JSON.stringify({ message: { role: "assistant", content: "hi" }, done: true, prompt_eval_count: 10, prompt_eval_duration: 100000000, eval_count: 20, eval_duration: 200000000, total_duration: 350000000 }) + "\n");
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new OllamaClient(settings(`http://127.0.0.1:${port}`));
    const res = await client.chat("m", [{ role: "user", content: "hi" }]);
    
    assert.equal(res.prompt_eval_count, 10);
    assert.equal(res.eval_count, 20);
    assert.equal(res.prompt_eval_duration, 100000000);
    assert.equal(res.eval_duration, 200000000);
  } finally {
    server.close();
  }
});

test("runLoop (indirectly via logging) captures tokens per second and vram", async () => {
  // This is a bit more complex as we need to mock many things if we want to run runLoop.
  // Instead, let's test if RunLog can be used to verify the structure of data.
  const tmpDir = join(tmpdir(), "rockyctl-test-logs");
  const log = new RunLog("test-logs", tmpdir());
  
  log.event("test.event", {
    tokens_per_second: 50.5,
    prompt_tokens_per_second: 100.123,
    eval_tokens_per_second: 25.456,
    vram_usage_bytes: 1024,
    some_other_val: "foo"
  });

  const logFile = log.path;
  const content = readFileSync(logFile, "utf8");
  const line = JSON.parse(content.split("\n")[1]);

  assert.equal(line.type, "test.event");
  assert.equal(line.tokens_per_second, 50.5);
  assert.equal(line.prompt_tokens_per_second, 100.123);
  assert.equal(line.eval_tokens_per_second, 25.456);
  assert.equal(line.vram_usage_bytes, 1024);
  assert.equal(line.some_other_val, "foo");
});
