# rockyctl

A [ralph-loop](https://lukasgrigis.dev/blog/ralph-loop/) agent harness for local LLMs, driven through Ollama.

The loop is the whole idea: pick the next task, hand it to a **generator** model with a fresh context and a
small set of tools, then have a separate **judge** model verify the result against the task's written
criteria. Pass → commit and move on. Fail → the critique is fed back and the generator tries again, up to
`maxAttempts`, after which the task is marked `blocked`. State lives on disk (git, `tasks.yaml`), never in
the model's context.

Unlike the original, which loops around `claude -p`, rockyctl *is* the agent: it runs its own tool-calling
loop over Ollama's `/api/chat` tools API, so it needs models that support tool calling.

## Install

```sh
npm install
npm run build
npm link          # or: npm install -g .
rockyctl --version
```

Requires Node 20.12+ and an Ollama server with the generator and judge models pulled.

## Use

In the repository you want the agent to work on:

```sh
rockyctl init      # writes rockyctl.yaml, PROMPT.md, tasks.yaml
rockyctl doctor    # checks Ollama, models, tool support, git, settings
rockyctl run       # loops until no pending tasks, a task is blocked, or maxIterations
rockyctl status
```

`rockyctl run --once` runs one iteration; `--task <id>` targets one task; `--dry-run` prints the prompt
that would be sent.

## Files

| File | Purpose |
| --- | --- |
| `rockyctl.yaml` | Settings. Every key is commented in the generated file. |
| `PROMPT.md` | Project-level instructions given to the generator on every iteration. |
| `tasks.yaml` | Work items: `id`, `title`, `description`, `criteria[]`, plus `status`/`attempts`/`lastCritique` managed by rockyctl. Comments are preserved. |
| `.rockyctl/logs/` | One JSONL log per run: every model turn, tool call, verdict, and commit. |

## Readiness

`doctor` and `run` both wait for Ollama under a single `ollama.readyTimeoutMs` budget: poll `/api/tags`
until the server answers, confirm both models are installed, then load each model into memory with an
empty chat request. Real requests pass `keep_alive` so models stay resident between iterations.

## Shell allowlist

The `run_command` tool only runs commands matching `shell.allow`. Commands are tokenized and never handed
to a shell on POSIX; shell metacharacters (`| & ; < > $` …) are rejected before anything runs, which is
what makes the allowlist meaningful. On Windows the (already validated) single command goes through
`cmd.exe` so `.cmd` shims like `npm` work.

Keep the allowlist platform-neutral: the model has `read_file`/`write_file`/`list_dir`/`search_files`, so
it never needs `cat`, `ls`, `grep`, `dir` or `type`. `doctor` warns about OS-specific entries.

## Development

```sh
npm run dev -- doctor          # run from source with tsx
npm test                       # unit tests
node tests/fake-ollama.mjs     # stand-in server for smoke tests (PORT=11434 by default)
```
