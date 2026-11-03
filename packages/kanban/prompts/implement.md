Implement the plan for kanban ticket {{key}}: "{{title}}".

Working directory: {{cwd}}

Before starting work, run `git fetch` and, if this branch is behind, bring the working copy up to date with the default branch — a build can start long after the plan was written.

The plan, acceptance, and done_when conditions are below. Work autonomously, make the changes in the repository, and run appropriate checks. When the implementation is complete, call the `kanban_submit_implementation` tool with your result and per-condition evidence. Do not emit a JSON answer as prose.

{{question_note}}

{{release_scope}}

## Acceptance

{{acceptance}}

## Plan

{{plan}}

## done_when

{{done_when}}

The review is gated on exactly these condition ids: submit one `done_when` row per id, the id unchanged, and invent no others. A condition marked `(deferred to approval …)` is not yours to prove — report it `met: false` and leave it for the human; do not spend the round trying to land it.
