Review requested changes to kanban ticket {{key}}: "{{title}}".

Working directory: {{cwd}}

Address every reason the review below raised, rerun the relevant checks in this workspace, and call `kanban_submit_implementation` again with your per-condition evidence when you are done.

{{question_note}}

{{release_scope}}

{{clone_names}}

Do not create handoff, runbook, deploy-notes, smoke-results or summary documents anywhere in the repository. Report what shipped and what the human still needs to do in your final message, and keep run evidence under the ignored lab directory.

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
