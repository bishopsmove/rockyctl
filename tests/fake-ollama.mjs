// Minimal stand-in for Ollama used to smoke-test `rockyctl doctor` and `run` without GPUs.
// Generator: writes hello.txt then summarizes. Judge: reads it, returns a passing verdict.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 11434);
let genTurn = 0;
let judgeTurn = 0;

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const json = (o, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(o));
  };

  if (req.url === "/api/tags") return json({ models: [{ name: "gen:latest", size: 1 }, { name: "judge:latest", size: 1 }] });
  if (req.url !== "/api/chat") return json({ error: "not found" }, 404);

  if (body.messages?.length === 0) {
    await new Promise((r) => setTimeout(r, 300)); // simulate model load
    return json({ model: body.model, message: { role: "assistant", content: "" }, done: true });
  }
  if (body.tools?.length === 1 && body.tools[0].function.name === "noop") {
    return json({ message: { role: "assistant", content: "ok" }, done: true });
  }

  const last = body.messages.at(-1);
  if (body.model.startsWith("gen")) {
    genTurn++;
    if (last.role === "user")
      return json({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "write_file", arguments: { path: "hello.txt", content: "hello\n" } } }] }, done: true });
    return json({ message: { role: "assistant", content: "Created hello.txt containing 'hello'." }, done: true });
  }
  judgeTurn++;
  if (last.role === "user" && judgeTurn === 1)
    return json({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "hello.txt" } } }] }, done: true });
  return json({ message: { role: "assistant", content: JSON.stringify({ pass: true, critique: "hello.txt exists with expected content", criteria: [{ index: 1, met: true }] }) }, done: true });
}).listen(port, () => console.log(`fake ollama on ${port}`));
