Review the implementation of kanban ticket {{key}}: "{{title}}".

Working directory: {{cwd}}

The implementer's work and the diff are below. Review against the plan and the done_when conditions. Do not edit files.

A passing review must be code-checkable against the plan:

- Return exactly one `done_when` row for every plan condition, using the **same id** as the plan. Mark `met`, give a confidence, and cite concrete evidence.
- Return one `acceptance_coverage` row for every starting acceptance statement, naming the plan condition id it is covered by.
- Do not return `pass` if any condition is unproven or any acceptance statement is uncovered. Return `fail` with a concrete `instruction` for the next implementation round.

Call `kanban_submit_review`. A complete pass is approved by code and moves directly to human approval; there is no separate verification session.

## Acceptance

{{acceptance}}

## Plan

{{plan}}

## done_when

{{done_when}}

## Implementation result

{{implementation}}

## Diff

{{diff}}
