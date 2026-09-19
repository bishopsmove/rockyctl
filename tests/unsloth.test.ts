import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { UnslothClient } from "../src/unsloth.js";
import { Provider, SettingsSchema } from "../src/config.js";

function settings(baseUrl: string, over: Partial<{ requestTimeoutMs: number; maxRetries: number; retryBackoffMs: number; thinkEffort?: "low" | "medium" | "high" | boolean }> = {}) {
  return SettingsSchema.parse({ providers: [{ providerName: "unsloth", baseUrl, ...over }] }).providers.find(p => p.providerName === "unsloth");
}

test("chat accumulates streamed content and tool_calls", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    res.write(JSON.stringify({ choices: [{ delta: { content: "Hel" }, finish_reason: null }] }) + "\n");
    res.write(JSON.stringify({ choices: [{ delta: { content: "lo" }, finish_reason: null }] }) + "\n");
    res.write(JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: { path: "x" } } }] }, finish_reason: null }] }) + "\n");
    res.write(JSON.stringify({ choices: [{ finish_reason: "stop" }] }) + "\n");
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new UnslothClient(settings(`http://127.0.0.1:${port}`) as Provider);
    const seen: number[] = [];
    const res = await client.chat("m", [{ role: "user", content: "hi" }], { onToken: (i) => seen.push(i.tokens) });
    assert.equal(res.message.content, "Hello");
    assert.equal(res.message.tool_calls?.length, 1);
    assert.equal(res.message.tool_calls?.[0].function.name, "read_file");
    assert.equal(res.done_reason, "stop");
    assert.ok(seen.length >= 2);
  } finally {
    server.close();
  }
});

test("chat respects requestTimeoutMs", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new UnslothClient(settings(`http://127.0.0.1:${port}`, { requestTimeoutMs: 200 }) as Provider);
    await assert.rejects(client.chat("m", [{ role: "user", content: "hi" }]), /exceeded requestTimeoutMs/);
  } finally {
    server.close();
  }
});

test("listModels returns models from /v1/models", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "model-1", object: "model" }, { id: "model-2", object: "model" }] }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new UnslothClient(settings(`http://127.0.0.1:${port}`) as Provider);
    const models = await client.listModels();
    assert.equal(models.length, 2);
    assert.equal(models[0].name, "model-1");
  } finally {
    server.close();
  }
});

test("generate sends the correct body", async () => {
  let receivedBody: any = null;
  const server = createServer(async (req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      receivedBody = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ text: "ok" }], usage: { total_tokens: 5 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new UnslothClient(settings(`http://127.0.0.1:${port}`) as Provider);
    const res = await client.generate("m", "hello", { temperature: 0.9, system: "system prompt" });
    assert.equal(res.response, "ok");
    assert.equal(receivedBody.model, "m");
    assert.equal(receivedBody.prompt, "system prompt\n\nhello");
    assert.equal(receivedBody.temperature, 0.9);
  } finally {
    server.close();
  }
});

test("waitUntilReady checks /v1/models connectivity", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new UnslothClient(settings(`http://127.0.0.1:${port}`) as Provider);
    await client.waitUntilReady(["m"]);
  } finally {
    server.close();
  }
});
