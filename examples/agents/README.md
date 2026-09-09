# Example subagent templates

These are illustrative [Claude Code subagent](https://docs.claude.com/en/docs/claude-code/sub-agents) definitions that call the bridge to run a task on a chosen agent CLI. They are **examples**, not an installed roster. Copy one, set the paths and model ids for your setup, and drop it in your own `agents/` directory.

The pattern is the same for every lane:

- The subagent is a thin forwarder: it runs the bridge, relays the result, and does not do the work itself.
- It reads the bridge exit code and acts on it: `0` relay the output, `3` return the parked `WAITING` block and the `answer` command to the driver, `4` return the `wait` command, `1` report the error.
- It never blanket-approves a parked permission; the driver decides.

Files here:

- `bridge-lane.md` - a generic single-model lane (start / send / relay).
- `reviewer-lane.md` - a read-only review lane (`--mode plan`, findings only).

Adapt the `--harness` and `--model` values to whatever you configured in `harnesses.json`.
