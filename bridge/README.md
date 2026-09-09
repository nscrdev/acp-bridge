# bridge contract

`acp-bridge.mjs` is a generic ACP client: it runs any ACP-speaking agent CLI as a long-lived, resumable session. No npm install; Node 22+ only.

## Commands

```bash
node acp-bridge.mjs start  --harness H --workspace DIR --model ID [--mode agent|plan|ask] [--name NAME] [--mcp FILE] [--wait] [--timeout SEC] -- "<prompt>"
node acp-bridge.mjs send   --name NAME [--wait] [--timeout SEC] [--model ID] [--mode M] -- "<follow-up>"
node acp-bridge.mjs wait   --name NAME [--timeout SEC]
node acp-bridge.mjs status --name NAME [--json]
node acp-bridge.mjs result --name NAME
node acp-bridge.mjs answer --name NAME --permission allow|always|reject
node acp-bridge.mjs answer --name NAME --question <qid> --option <optionId>[,<optionId>]
node acp-bridge.mjs answer --name NAME --plan accept|reject
node acp-bridge.mjs cancel --name NAME
node acp-bridge.mjs stop   --name NAME
node acp-bridge.mjs list
node acp-bridge.mjs models [--harness H] [--workspace DIR]
node acp-bridge.mjs fork-chat --chat <chatId> [--name NAME] [--workspace DIR] [--mode ask|plan|agent]
```

`--harness` selects an entry from `harnesses.json` (defaults to the `default` key there).

Exit codes for `start`, `send`, `wait`:

| code | meaning | what to do |
|---|---|---|
| 0 | turn ended; final text is on stdout | read it |
| 3 | agent is parked on a permission, question, or plan | run the `answer` line printed in the status, then `wait` |
| 4 | wait timed out; daemon still running | `wait` again later, or `status` |
| 1 | error | read `status` and `daemon.log` |

## Files

`~/.claude/tools/acp-bridge/sessions/<name>/`

- `state.json` - status, model, mode, agent session id, turns, pending item
- `transcript.jsonl` - every JSON-RPC message in and out, plus bridge events
- `result.md` - last completed turn
- `daemon.log` - daemon stdout/stderr
- `inbox/` - commands from the CLI to the daemon

## Permission policy

`policy.default.json` next to the script. Shell commands are matched with regexes: deny first, then allow, else park. A workspace can add `<workspace>/.acp-bridge/policy.json` with extra `execute.deny` and `execute.allow` arrays. Parked items time out (default 20 minutes) and are then rejected. There is no allow-all switch on purpose; a code-side allow-all is the same risk as running an agent with no approval gate.

File edits do not prompt in `agent` mode. Use `--mode plan` or `--mode ask` for read-only runs.

## Known behaviors

- **Model selection.** The bridge tries `session/set_model` first, then `session/set_config_option` with `configId: "model"` (some agents implement only the latter). If both fail, or the agent acks the change but its echoed config still reports a different model, the run continues on whatever the agent is actually on and `status --json` shows a `warnings` entry. Check `model:` in the status line when the model matters.
- **CLI-default side effect.** On some agents, selecting a model over ACP rewrites the CLI's own default model. If a harness sets `cliConfig`, the bridge snapshots that file at connect and restores it on exit. If a daemon is hard-killed, check that file.
- **Process trees.** A launcher may be `cmd.exe -> shell -> node`. The bridge kills the whole tree on exit. If you kill a daemon by hand, check for leftover agent processes.
- **Idle exit.** Daemons exit after 30 idle minutes (`--idle-exit MIN`). The agent session id is kept, so `send` resumes with a fresh daemon (via `session/load`).
- **Restart drain.** Only `send` messages survive a daemon restart; stale `answer` and `stop` files are dropped.
- **Crash-safe state.** `state.json` is written debounced (at most every 250 ms) during a turn and flushed immediately on every real transition (status change, turn end, exit). On Windows the tmp->final rename can hit a transient EPERM/EBUSY/EACCES from antivirus or the indexer; the writer retries a few times then falls back to an in-place write and never throws. A failed checkpoint is logged, never fatal.
- **Long turns must be backgrounded.** A foreground `--wait` run that the caller kills at its own timeout can SIGTERM the whole process group and take the daemon with it. For a multi-minute turn, background the call, or start without `--wait` and poll with `wait --name N`.

## Desktop chats and fork-chat

Some agents (e.g. Cursor) keep interactive desktop/CLI chats in a different store than ACP sessions, so `session/list` and `session/load` cannot see them. `fork-chat` copies such a chat's store into a new ACP session id and registers it as a bridge session; you can then `send` to it and the agent answers with the chat's full history. It is a snapshot fork: nothing you send appears in the desktop UI, and new desktop messages do not reach the fork. Paths are agent-specific; see the code for where each harness looks.

## Adding a harness

Add an entry to `harnesses.json` (start from `harnesses.example.json`): `command`, `args`, `authMethod` (or null), optional `modelAliases`, optional `cliConfig`, optional `extensions`. The `extensions: "cursor"` flag changes how `cursor/*` ACP extension methods are handled; unknown extension requests get a `skipped` outcome.

## Per-session MCP servers

`start --mcp FILE.json` passes a JSON array of ACP `mcpServers` to `session/new`. Whether a given agent honors client-supplied MCP servers varies; test before relying on it.
