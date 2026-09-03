import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { OllamaClient, describeError } from "../src/ollama.js";
import { SettingsSchema } from "../src/config.js";

function settings(baseUrl: string, over: Partial<{ requestTimeoutMs: number }> = {}) {
  return SettingsSchema.parse({ ollama: { baseUrl, ...over } }).ollama;
}

test("chat accumulates streamed content and tool_calls", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write(JSON.stringify({ message: { role: "assistant", content: "Hel" }, done: false }) + "\n");
    res.write(JSON.stringify({ message: { role: "assistant", content: "lo" }, done: false }) + "\n");
    res.write(JSON.stringify({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "x" } } }] }, done: false }) + "\n");
    res.end(JSON.stringify({ message: { role: "assistant", content: "" }, done: true, eval_count: 3 }) + "\n");
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new OllamaClient(settings(`http://127.0.0.1:${port}`));
    const seen: number[] = [];
    const res = await client.chat("m", [{ role: "user", content: "hi" }], { onToken: (i) => seen.push(i.tokens) });
    assert.equal(res.message.content, "Hello");
    assert.equal(res.message.tool_calls?.length, 1);
    assert.equal(res.message.tool_calls?.[0].function.name, "read_file");
    assert.equal(res.eval_count, 3);
    assert.ok(seen.length >= 3);
  } finally {
    server.close();
  }
});

test("chat surfaces a mid-stream Ollama error", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.end(JSON.stringify({ error: "runner process has terminated" }) + "\n");
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new OllamaClient(settings(`http://127.0.0.1:${port}`));
    await assert.rejects(client.chat("m", [{ role: "user", content: "hi" }]), /runner process has terminated/);
  } finally {
    server.close();
  }
});

test("chat reports a dropped connection instead of a bare 'fetch failed'", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write(JSON.stringify({ message: { role: "assistant", content: "partial" }, done: false }) + "\n");
    setTimeout(() => res.socket?.destroy(), 20);
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new OllamaClient(settings(`http://127.0.0.1:${port}`));
    await assert.rejects(client.chat("m", [{ role: "user", content: "hi" }]), (e: Error) => {
      assert.match(e.message, /Streaming from m failed|ended without a final chunk/);
      assert.doesNotMatch(e.message, /^fetch failed$/);
      return true;
    });
  } finally {
    server.close();
  }
});

test("chat honours requestTimeoutMs", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" }); // then never send anything
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new OllamaClient(settings(`http://127.0.0.1:${port}`, { requestTimeoutMs: 200 }));
    await assert.rejects(client.chat("m", [{ role: "user", content: "hi" }]), /exceeded requestTimeoutMs/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("connection refused is described with its code", async () => {
  // Grab a free port, then close it so nothing is listening there.
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const client = new OllamaClient(settings(`http://127.0.0.1:${port}`));
  await assert.rejects(client.listModels(1000), /ECONNREFUSED/);
});

test("describeError unwraps causes", () => {
  const inner = Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" });
  const outer = new TypeError("fetch failed", { cause: inner });
  assert.equal(describeError(outer), "fetch failed <- [ECONNRESET] connect ECONNRESET");
});
