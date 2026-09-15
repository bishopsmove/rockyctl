import { createServer } from "node:http";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { LlamaCppClient } from "../src/llamacpp.js";
import { SettingsSchema } from "../src/config.js";
import type { Provider } from "../src/config.js";

function settings(baseUrl: string, over: Partial<{ requestTimeoutMs: number; maxRetries: number; retryBackoffMs: number }> = {}) {
  return SettingsSchema.parse({ providers: [{ providerName: "llama.cpp", baseUrl, ...over }] }).providers.find(p => p.providerName === "llama.cpp") as Provider;
}

test("chat accumulates streamed content", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    // res.write(JSON.stringify({ choices: [{ delta: { content: "Hello" } }, { delta: { content: " world" } }], finish_reason: "stop" }) + "\n");
    res.write(JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }) + "\n");
    res.write(JSON.stringify({ choices: [{ delta: { content: " world" } }]  }) + "\n");
    res.end(JSON.stringify({ choices:[{finish_reason: "stop" }]}));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new LlamaCppClient(settings(`http://127.0.0.1:${port}`) as Provider);
    const res = await client.chat("m", [{ role: "user", content: "hi" }]);
    assert.equal(res.message.content, "Hello world");
    assert.equal(res.done_reason, "stop");
  } finally {
    server.close();
  }
});

test("chat handles errors", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Something went wrong" }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new LlamaCppClient(settings(`http://127.0.0.1:${port}`) as Provider);
    await assert.rejects(client.chat("m", [{ role: "user", content: "hi" }]), /HTTP 500/);
  } finally {
    server.close();
  }
});

test("generate works", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ text: "Response" }], usage: { total_tokens: 10 } }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new LlamaCppClient(settings(`http://127.0.0.1:${port}`) as Provider);
    const res = await client.generate("m", "hello");
    assert.equal(res.response, "Response");
    assert.equal(res.total_duration, 10);
  } finally {
    server.close();
  }
});

test("waitUntilReady checks health", async () => {
  const server = createServer((_req, res) => {
    if (_req.url === "/health") {
      res.writeHead(200);
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new LlamaCppClient(settings(`http://127.0.0.1:${port}`) as Provider);
    await client.waitUntilReady(["m"]);
  } finally {
    server.close();
  }
});
