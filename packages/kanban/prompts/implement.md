Implement the plan for kanban ticket {{key}}: "{{title}}".

Working directory: {{cwd}}

Before starting work, run `git fetch` and, if this branch is behind, bring the working copy up to date with the default branch — a build can start long after the plan was written.

The plan, acceptance, and done_when conditions are below. Work autonomously, make the changes in the repository, and run appropriate checks. When the implementation is complete, call the `kanban_submit_implementation` tool with your result and per-condition evidence. Do not emit a JSON answer as prose.

## Acceptance

{{acceptance}}

## Plan

{{plan}}

## done_when

{{done_when}}
