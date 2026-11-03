Implement the plan for kanban ticket {{key}}: "{{title}}".

Before starting work, run `git fetch` and, if this branch is behind, bring the working copy up to date with the default branch — a build can start long after the plan was written.

Work autonomously, make the changes in the repository, and run appropriate checks. When the implementation is complete, call the `kanban_submit_implementation` tool with your result and per-condition evidence. Ending a turn without calling `kanban_submit_implementation` parks the ticket for a human, even when the work is done: always finish by calling it (with status `blocked` if you cannot continue).

This session runs under the `{{write_mode}}` file sandbox. Unless that is `danger-full-access`, `sudo` cannot run here at all: the sandbox sets `no_new_privs` on every confined child and sudo refuses to run under it before it ever reads sudoers, so `sudo -n <cmd>` exits 1 with `The "no new privileges" flag is set` however the machine is configured — and `sudo` is word-denied in the plan grants, so nothing lifts it. Do not spend attempts on sudo in a sandboxed session: if the work needs it, stop and say so (an optionless question, or status `blocked`) and name the fix — set this ticket's write mode to Full access and Retry.

{{question_note}}

{{release_scope}}

{{clone_names}}

Do not create handoff, runbook, deploy-notes, smoke-results or summary documents anywhere in the repository. Report what shipped and what the human still needs to do in your final message, and keep run evidence under an ignored directory.

## The ticket, as the human wrote it

{{ticket_state}}

## Plan

{{plan}}

## done_when

{{done_when}}

The review is gated on exactly these condition ids: submit one `done_when` row per id, the id unchanged, and invent no others. A condition marked `(deferred to approval …)` is not yours to prove — report it `met: false` and leave it for the human; do not spend the round trying to land it.

## Submission contract

{{submission_contract}}
