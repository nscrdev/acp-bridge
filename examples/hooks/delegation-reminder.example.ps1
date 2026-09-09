# delegation-reminder.example.ps1
# Example UserPromptSubmit hook (Claude Code): injects a short model-routing
# reminder into context on every turn, so the driver consistently delegates
# bounded work to bridge lanes instead of doing it inline.
#
# This is an EXAMPLE. Replace the model names and lanes with your own harnesses
# and models from harnesses.json. Register it in your Claude Code settings.json
# under hooks.UserPromptSubmit. Static output by design (does not read stdin) so
# it cannot hang.

$reminder = @'
[DELEGATION CHECK - route bounded work to bridge lanes; keep the driver's context small]
Default: delegate a bounded, repo-scoped task to a bridge lane rather than doing it inline.
Keep on the driver: user-facing / taste calls, the final ship decision, anything that needs
your live tools or this session's context.

Pick a lane by task (edit these to match your harnesses.json):
- Agentic coding / feature build / debugging  -> your default coding model
- Cheap mechanical / bulk edits / wide reads   -> a cheaper model
- Hardest root-cause                           -> your strongest model / highest thinking tier
- Independent pre-ship review                  -> a DIFFERENT model family than the author,
  or at least a higher thinking tier of the same family; never the same model at the same tier

Bridge contract: exit 0 = done (relay verbatim), exit 3 = parked on a permission/question/plan
(the lane returns the WAITING block + the answer command; the driver decides, then `wait`),
exit 4 = still running (return the `wait` command), exit 1 = error. Never blanket-allow a parked
permission. Long turns must be backgrounded.
'@

$out = @{
  hookSpecificOutput = @{
    hookEventName     = "UserPromptSubmit"
    additionalContext = $reminder
  }
}

Write-Output ($out | ConvertTo-Json -Compress)
exit 0
