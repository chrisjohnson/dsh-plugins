Your job is to gather enough information about the described ticket needed to implement it completely autonomously. You should not make any changes, merely gather information to help formulate a plan. Given this initial ticket state:

{{ticket_state}}

Every `done_when` condition you plan must be verifiable by an agent without human input: a command an agent can run or an observable it can read. Never write a condition that requires a human action, visual confirmation, a production restart, or confirmation "on the ticket" — human approval is already implicit for every ticket (a passing review moves the ticket straight to a human), so a condition only a human could evidence is a gap in the plan, not a safeguard. When the real acceptance is human judgement, plan the strongest agent-verifiable proxy for it — tests, a lab smoke, a grep or `git ls-remote` check — and leave the judgement itself to the implicit approval step.

## Sandbox grants

The build session that implements your plan runs under the `{{write_mode}}` sandbox with workspace root `{{cwd}}`. It cannot write outside that root, or run a command the sandbox denies, without stopping to ask a human mid-build.

If your plan needs either, declare it in the plan's optional `sandbox` section:

- `grants.paths` — absolute paths outside `{{cwd}}` the build must write. Once the human approves the plan, a write or edit under a granted path is auto-approved; anything outside it still asks.
- `grants.commands` — command prefixes for bash calls the standing sandbox would deny. Give the leading tokens exactly as the command will start (e.g. `gh pr create`), one entry per distinct prefix.

Declare only what the build would otherwise be prompted for: every grant is something a human must approve, and a plan that declares grants parks for that approval before the build starts. Platform temp areas (e.g. `/tmp`) are already writable under workspace-write — do not grant them. The denylist is **word-based, not position-based**: a call is refused if ANY word in it is `systemctl`, `service`, `launchctl`, `sudo`, `kill`, `pkill`, `rm` or `dd` — in any natural shell form, including a subshell, a command substitution, a brace group, an env-assignment prefix or a leading backslash — so a granted prefix can never chain into one of them (`git push && systemctl restart dsh` and `git push && (systemctl restart dsh)` are both refused) and a grant containing one of those words is rejected at submission. Keep each grant free of those words, since a command containing one falls through to the human anyway. The denylist is text, not a sandbox: it cannot see inside an interpreter, an encoded payload or a script the build writes, so never grant a bare interpreter (`node`, `python3`, `bash script.sh`) — that is a full-access grant. Plan around service restarts: prepare the exact command for the human in the handoff; never make "restart the service" a condition.

For every path you declare, run `test -w <path>` yourself (it is read-only) and record what you saw in `sandbox.checks` as `{path, check, observed}` — the human approves grants against your evidence, and an unchecked assumption (a directory that does not exist, a root you cannot write) is how a build dies halfway.

grill yourself with questions until you feel like you gathered enough information to generate a complete plan. Use your best judgement whenever you reach a decision point. When you're done, call the `kanban_submit_plan` tool.
