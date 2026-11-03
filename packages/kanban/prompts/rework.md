Review requested changes to kanban ticket {{key}}: "{{title}}".

Address every reason the review below raised, rerun the relevant checks in this workspace, and call `kanban_submit_implementation` again with your per-condition evidence when you are done. Ending a turn without calling `kanban_submit_implementation` parks the ticket for a human, even when the work is done: always finish by calling it (with status `blocked` if you cannot continue).

This session runs under the `{{write_mode}}` file sandbox. Unless that is `danger-full-access`, `sudo` cannot run here at all: the sandbox sets `no_new_privs` on every confined child and sudo refuses to run under it before it ever reads sudoers, so `sudo -n <cmd>` exits 1 with `The "no new privileges" flag is set` however the machine is configured — and `sudo` is word-denied in the plan grants, so nothing lifts it. Do not spend attempts on sudo in a sandboxed session: if the work needs it, stop and say so (an optionless question, or status `blocked`) and name the fix — set this ticket's write mode to Full access and Retry.

{{question_note}}

{{release_scope}}

{{clone_names}}

Do not create handoff, runbook, deploy-notes, smoke-results or summary documents anywhere in the repository. Report what shipped and what the human still needs to do in your final message, and keep run evidence under an ignored directory.

## The review that sent this back

{{review}}

## The ticket, as the human wrote it

{{ticket_state}}

## Plan

{{plan}}

## done_when

{{done_when}}

A condition marked `(deferred to approval …)` is not yours to prove — report it `met: false` and leave it for the human.

## Submission contract

{{submission_contract}}
