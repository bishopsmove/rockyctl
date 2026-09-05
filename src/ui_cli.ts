import readline from "node:readline";
import { Command } from "commander";
import { ui } from "./log.js";

export async function runUi(program: Command) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "rockyctl > "
  });

  console.log("\n--- Rockyctl UI ---");
  console.log("Commands: /doctor, /status, /config, /run, /exit, /help");
  console.log("Commands must start with / (e.g. /doctor)");
  console.log("------------------\n");

  rl.prompt();

  return new Promise<void>((resolve) => {
    rl.on("line", async (line) => {
      const input = line.trim();
      if (!input.startsWith("/")) {
        ui.warn("All commands must start with /");
        rl.prompt();
        return;
      }

      const command = input.substring(1).trim();

      if (command === "exit") {
        rl.close();
        resolve();
        return;
      }

      if (command === "help") {
        console.log("Available commands:\n/doctor, /status, /config, /run, /exit, /help");
        rl.prompt();
        return;
      }

      const originalArgv = [...process.argv];
      
      // We want to mimic: rockyctl <command>
      // process.argv[0] is the executable (e.g. node)
      // process.argv[1] is the script (e.g. index.ts)
      // We replace the command which is at index 2 (or 3 if we include tsx/node)
      // Actually, originalArgv has [node, script, 'ui', ...]
      // We want [node, script, command]
      
      const newArgv = [originalArgv[0], originalArgv[1], command];
      
      process.argv = newArgv;
      
      try {
        // commander's .parseAsync() might not be safe to call multiple times.
        // We'll use a temporary Command instance if necessary, but for prototype, 
        // we'll try calling it on the original program.
        await program.parseAsync(newArgv);
      } catch (err: any) {
        ui.fail(err.message || String(err));
      } finally {
        process.argv = originalArgv;
      }

      rl.prompt();
    });

    rl.on("close", () => {
      resolve();
    });
  });
}
