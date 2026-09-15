import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { VLLMClient } from "../src/vllm.js";
import { SettingsSchema } from "../src/config.js";
import type { Provider } from "../src/config.js";

function settings(baseUrl: string, over: Partial<Provider> = {}) {
  return SettingsSchema.parse({ 
    providers: [{ 
      providerName: "vllm", 
      baseUrl, 
      ...over 
    }] 
  }).providers.find(p => p.providerName === "vllm");
}

test("chat accumulates streamed content and tool_calls", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write(JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }) + "\n");
    res.write(JSON.stringify({ choices: [{ delta: { content: "lo" } }] }) + "\n");
    res.write(JSON.stringify({ choices: [{ delta: { content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\": \"x\"}" } }] }, finish_reason: "stop" }] }) + "\n");
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new VLLMClient(settings(`http://127.0.0.1:${port}`) as Provider);
    const res = await client.chat("m", [{ role: "user", content: "hi" }]);
    assert.equal(res.message.content, "Hello");
    assert.equal(res.message.tool_calls?.length, 1);
    assert.equal(res.message.tool_calls?.[0].function.name, "read_file");
    assert.equal(res.done_reason, "stop");
  } finally {
    server.close();
  }
});

test("chat surfaces an error", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = new VLLMClient(settings(`http://127.0.0.1:${port}`) as Provider);
    await assert.rejects(client.chat("m", [{ role: "user", content: "hi" }]), /HTTP 500/);
  } finally {
    server.close();
  }
});

test("waitUntilReady checks health endpoint", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
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
    const client = new VLLMClient(settings(`http://127.0.0.1:${port}`) as Provider);
    await client.waitUntilReady(["m"]);
  } finally {
    server.close();
  }
});
