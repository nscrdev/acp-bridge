# acp-bridge

Drive one coding agent from another over **ACP** (the [Agent Client Protocol](https://agentclientprotocol.com/), JSON-RPC over stdio). A small Node script (no dependencies) runs any ACP-speaking CLI agent as a long-lived, resumable background session, so an orchestrating agent can start work, answer permission prompts, and read the result without keeping the whole run in its own context.

Works with any agent CLI that exposes an ACP server — Cursor CLI, Codex CLI, Devin CLI, Gemini CLI, Claude Code, or your own. You choose which; nothing is bundled or required.

## What you get

- **Small driver context.** The bridge daemon owns the token stream and writes it to disk. The driver reads a short status or the final message, not every chunk.
- **Stay in the loop.** When a lane wants to run a shell command outside your policy, or the agent asks a question, the run *parks* and the driver answers with one command.
- **Resumable sessions.** Each run is a named session you can `send` follow-ups to, `stop`, and resume later.
- **Per-lane permission policy.** A regex allow/deny/park policy gates shell commands. No blanket "yes".
- **Any model, any seat.** Point a harness at whatever agent CLI and login you already have.

## Requirements

- Node.js 22+ (tested on 26).
- At least one agent CLI installed and logged in that speaks ACP (e.g. `cursor-agent`, `codex`, `devin`, `gemini`, `claude-code-acp`).

## Quickstart

```bash
# 1. Tell the bridge which agent CLIs to use
cp bridge/harnesses.example.json bridge/harnesses.json
#    edit bridge/harnesses.json: set the command/args for each harness you have

# 2. List the models a harness offers
node bridge/acp-bridge.mjs models --harness cursor

# 3. Run a task, wait for the result
node bridge/acp-bridge.mjs start --harness cursor --name my-lane \
  --workspace "/path/to/repo" --model <model-id> --wait --timeout 900 \
  -- "Do the thing. State what done looks like."
```

Exit codes for `start`/`send`/`wait`:

| code | meaning | what to do |
|------|---------|------------|
| 0 | turn ended; final text on stdout | read it |
| 3 | parked on a permission/question/plan | run the printed `answer` command, then `wait` |
| 4 | timed out; daemon still running | `wait` again later, or `status` |
| 1 | error | read `status` and `daemon.log` |

Full command and behavior contract: [bridge/README.md](bridge/README.md).

## Commands

```
start   --harness H --workspace DIR --model ID [--mode agent|plan|ask] [--name N] [--mcp FILE] [--wait] -- "<prompt>"
send    --name N [--wait] [--model ID] [--mode M] -- "<follow-up>"
wait    --name N [--timeout SEC]
status  --name N [--json]
result  --name N
answer  --name N (--permission allow|always|reject | --question <qid> --option <oid> | --plan accept|reject)
cancel  --name N
stop    --name N
list
models  [--harness H] [--workspace DIR]
```

## Configure

`bridge/harnesses.json` (your copy, git-ignored) defines each backend: the command to spawn, its ACP args, an optional auth method, optional model aliases, and an optional CLI-config path the bridge should snapshot/restore. See `bridge/harnesses.example.json` for the shape and inline notes.

`bridge/policy.default.json` is the shell-permission policy: `execute.deny` and `execute.allow` are regex lists tested against the command string; anything unmatched parks for the driver to answer. A workspace can extend it with `<workspace>/.acp-bridge/policy.json`.

## Optional examples

`examples/` holds *illustrative* templates you can copy and adapt — they are not installed or required:

- `examples/agents/` — subagent definitions that call the bridge for a given model lane.
- `examples/hooks/` — a routing-reminder hook that injects model-routing rules per prompt.
- `examples/skills/orchestrator/` — an orchestration playbook for running many lanes across seats.

Bring your own routing; the bridge does not impose one.

## How it works

`bridge/acp-bridge.mjs` spawns the agent CLI in ACP mode, keeps the pipe open in a detached per-session daemon, streams `session/update` notifications to a transcript on disk, and exposes a tiny CLI (`start`, `send`, `status`, `answer`, `wait`, `stop`, `list`). Session state lives under `~/.claude/tools/acp-bridge/sessions/<name>/`.

## License

MIT. See [LICENSE](LICENSE).
