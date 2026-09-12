import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { OllamaClient, describeError } from "../src/ollama.js";
import { Provider, SettingsSchema } from "../src/config.js";

function settings(baseUrl: string, over: Partial<{ requestTimeoutMs: number; maxRetries: number; retryBackoffMs: number; thinkEffort?: "low" | "medium" | "high" | boolean }> = {}) {
  // Tests that aren't exercising retry behaviour don't want it: they just slow them down.
  return SettingsSchema.parse({ providers: [{ providerName: "ollama", baseUrl, ...over }] }).providers.find(p => p.providerName === "ollama");
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
    const client = new OllamaClient(settings(`http://127.0.0.1:${port}`) as Provider);
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
    const client = new OllamaClient(settings(`http://127.0.0.1:${port}`) as Provider);
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
    const client = new OllamaClient(settings(`http://127.0.0.1:${port}`) as Provider);
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
    const client = new OllamaClient(settings(`http://127.0.0.1:${port}`, { requestTimeoutMs: 200 }) as Provider);
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
  const client = new OllamaClient(settings(`http://127.0.0.1:${port}`) as Provider);
  await assert.rejects(client.listModels(1000), /ECONNREFUSED/);
});

test("chat retries after a transient connection reset and eventually succeeds", async () => {
  let requestCount = 0;
  const server = createServer((_req, res) => {
    requestCount++;
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    if (requestCount === 1) {
      res.write(JSON.stringify({ message: { role: "assistant", content: "partial" }, done: false }) + "\n");
      setTimeout(() => res.socket?.destroy(), 20);
      return;
    }
    res.end(JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true }) + "\n");
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new OllamaClient(settings(`http://127.0.0.1:${port}`, { maxRetries: 2, retryBackoffMs: 10 }) as Provider);
    const retries: { attempt: number; maxAttempts: number; error: string }[] = [];
    const res = await client.chat("m", [{ role: "user", content: "hi" }], {
      onRetry: (info) => retries.push({ attempt: info.attempt, maxAttempts: info.maxAttempts, error: info.error }),
    });
    assert.equal(res.message.content, "ok");
    assert.equal(requestCount, 2);
    // The failure must be surfaced to the caller, not swallowed silently.
    assert.equal(retries.length, 1);
    assert.equal(retries[0].attempt, 1);
    assert.equal(retries[0].maxAttempts, 3);
    assert.match(retries[0].error, /Streaming from m failed|ended without a final chunk/);
  } finally {
    server.close();
  }
});

test("chat does not retry a deliberate requestTimeoutMs abort", async () => {
  let requestCount = 0;
  const server = createServer((_req, res) => {
    requestCount++;
    res.writeHead(200, { "content-type": "application/x-ndjson" }); // then never send anything
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new OllamaClient(settings(`http://127.0.0.1:${port}`, { requestTimeoutMs: 100, maxRetries: 3, retryBackoffMs: 10 }) as Provider);
    await assert.rejects(
      client.chat("m", [{ role: "user", content: "hi" }], { onRetry: () => { /* avoid error if test fails */ } }),
      /exceeded requestTimeoutMs/,
    );
    assert.equal(requestCount, 1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("chat does not retry an HTTP 4xx", async () => {
  const server = createServer((_req, res) => {
    requestCount++;
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "model does not support tools" }));
  });
  let requestCount = 0;
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new OllamaClient(settings(`http://127.0.0.1:${port}`, { maxRetries: 3, retryBackoffMs: 10 }) as Provider);
    await assert.rejects(client.chat("m", [{ role: "user", content: "hi" }]), /does not support tools/);
    assert.equal(requestCount, 1);
  } finally {
    server.close();
  }
});

test("describeError unwraps causes", async () => {
  const inner = Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" });
  const outer = new TypeError("fetch failed", { cause: inner });
  assert.equal(describeError(outer), "fetch failed <- [ECONNRESET] connect ECONNRESET");
});

test("chat sends the top-level think field when thinkEffort is set", async () => {
  let receivedBody: Record<string, unknown> | undefined;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      receivedBody = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true }) + "\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new OllamaClient(settings(`http://127.0.0.1:${port}`, { thinkEffort: "high" as any }) as Provider);
    await client.chat("m", [{ role: "user", content: "hi" }]);
    assert.ok(receivedBody, "server should have received the chat request");
    assert.equal(receivedBody.think, "high");
  } finally {
    server.close();
  }
});

test("chat omits the think field when thinkEffort is absent", async () => {
  let receivedBody: Record<string, unknown> | undefined;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      receivedBody = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true }) + "\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new OllamaClient(settings(`http://127.0.0.1:${port}`) as Provider);
    await client.chat("m", [{ role: "user", content: "hi" }]);
    assert.ok(receivedBody, "server should have received the chat request");
    assert.ok(!("think" in receivedBody), "think field must be omitted when thinkEffort is not set");
  } finally {
    server.close();
  }
});

test("generate sends the top-level think field for string and boolean thinkEffort values", async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push(JSON.stringify(body.think));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ response: "ok", done: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    for (const value of ["low" as const, true, false]) {
      const client = new OllamaClient(settings(`http://127.0.0.1:${port}`, { thinkEffort: value as any }) as Provider);
      await client.generate("m", "hello");
      assert.ok(seen.includes(JSON.stringify(value)));
    }
  } finally {
    server.close();
  }
});

test("generate omits the think field when thinkEffort is absent", async () => {
  let receivedBody: Record<string, unknown> | undefined;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      receivedBody = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ response: "ok", done: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new OllamaClient(settings(`http://127.0.0.1:${port}`) as Provider);
    await client.generate("m", "hello");
    assert.ok(receivedBody, "server should have received the generate request");
    assert.ok(!("think" in receivedBody), "think field must be omitted when thinkEffort is not set");
  } finally {
    server.close();
  }
});

test("waitUntilReady calls /api/ps and only warms up missing models", async () => {
  let psCalled = false;
  const warmUps: string[] = [];

  const server = createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "model1" }, { name: "model2" }] }));
    } else if (req.url === "/api/ps") {
      psCalled = true;
      res.writeHead(200, { "content-type": "application/json" });
      // model1 is already loaded
      res.end(JSON.stringify({ models: [{ name: "model1", size: 100, size_vram: 100 }] }));
    } else if (req.url === "/api/chat" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        const parsed = JSON.parse(body);
        warmUps.push(parsed.model);
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.end(JSON.stringify({ message: { content: "ok" }, done: true }) + "\n");
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new OllamaClient(settings(`http://127.0.0.1:${port}`) as Provider);
    await client.waitUntilReady(["model1", "model2"]);

    assert.strictEqual(psCalled, true, "should have called /api/ps");
    assert.deepStrictEqual(warmUps, ["model2"], "should only warm up model2");
  } finally {
    server.close();
  }
});
