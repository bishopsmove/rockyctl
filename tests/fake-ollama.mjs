// Minimal stand-in for Ollama used to smoke-test `rockyctl doctor` and `run` without GPUs.
// Generator: writes hello.txt then summarizes. Judge: reads it, returns a passing verdict.
// Honors `stream: true` by emitting NDJSON chunks, like the real server.
//   PORT=11499 node tests/fake-ollama.mjs
//   SLOW_MS=400000 ... simulates a generation that takes longer than undici's 300s default.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 11434);
const slowMs = Number(process.env.SLOW_MS ?? 0);
let judgeTurn = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const json = (o, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(o));
  };
  const sizes = { gen: 16e9, judge: 8e9 };
  const streamed = async (message) => {
    // Send headers now, then a few chunks: mirrors Ollama's streaming shape.
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    if (slowMs) await sleep(slowMs);
    const words = (message.content ?? "").split(/(?<=\s)/);
    for (const w of words) {
      if (w) res.write(JSON.stringify({ model: body.model, message: { role: "assistant", content: w }, done: false }) + "\n");
      await sleep(5);
    }
    if (message.tool_calls) {
      res.write(JSON.stringify({ model: body.model, message: { role: "assistant", content: "", tool_calls: message.tool_calls }, done: false }) + "\n");
    }
    res.end(JSON.stringify({ model: body.model, message: { role: "assistant", content: "" }, done: true, done_reason: "stop", eval_count: words.length, prompt_eval_count: 100, total_duration: 1.2e9 }) + "\n");
  };
  const reply = (message) => (body.stream ? streamed(message) : json({ model: body.model, message, done: true }));

  if (req.url === "/api/tags") return json({ models: [{ name: "gen:latest", size: sizes.gen }, { name: "judge:latest", size: sizes.judge }] });
  if (req.url === "/api/ps")
    return json({
      models: [
        { name: "gen:latest", size: sizes.gen, size_vram: sizes.gen, context_length: 32768 },
        { name: "judge:latest", size: sizes.judge, size_vram: sizes.judge * 0.6, context_length: 32768 },
      ],
    });
  if (req.url !== "/api/chat") return json({ error: "not found" }, 404);

  if (body.messages?.length === 0) {
    await sleep(300); // simulate model load
    return json({ model: body.model, message: { role: "assistant", content: "" }, done: true });
  }
  if (body.tools?.length === 1 && body.tools[0].function.name === "noop") {
    return json({ message: { role: "assistant", content: "ok" }, done: true });
  }

  const last = body.messages.at(-1);
  if (body.model.startsWith("gen")) {
    if (last.role === "user")
      return reply({ role: "assistant", content: "I'll create the file now.", tool_calls: [{ function: { name: "write_file", arguments: { path: "hello.txt", content: "hello\n" } } }] });
    return reply({ role: "assistant", content: "Created hello.txt containing 'hello'. Verified by reading it back." });
  }
  judgeTurn++;
  if (last.role === "user" && judgeTurn === 1)
    return reply({ role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "hello.txt" } } }] });
  return reply({ role: "assistant", content: JSON.stringify({ pass: true, critique: "hello.txt exists with expected content", criteria: [{ index: 1, met: true }] }) });
}).listen(port, () => console.log(`fake ollama on ${port}${slowMs ? ` (slow: ${slowMs}ms before first token)` : ""}`));
