Review the implementation of kanban ticket {{key}}: "{{title}}".

Working directory: {{cwd}}

The plan, the acceptance statements, the implementer's result and the diff are already in this conversation. If they are not — a session reopened after a restart starts empty — call `kanban_plan` for the plan and its conditions and read the working tree with git before judging anything. Do not edit files. Review adversarially: assume the work is broken until you have proved otherwise, and check every `done_when` condition against the code, not against what the implementer claimed.

Then call `kanban_submit_review` with exactly these keys:

- `verdict` — `"pass"` or `"fail"`.
- `reasons` — array of strings: why you reached the verdict. A `fail` must carry at least one.
- `scope_drift` — optional string: any work outside the ticket/plan scope.
- `done_when` — one row per plan condition listed below, using the **same id**. Each row is `{id, met, confidence, evidence}`: `met` a boolean, `confidence` a number 0..1, `evidence` a concrete observable (a path, a `file:line`, a command and what it printed). The engine rejects a `pass` while any condition is missing, unmet, below the confidence threshold, has no evidence, or carries an id the plan never declared.
- `acceptance_coverage` — one row per starting acceptance statement, `{condition, acceptance}`, naming the plan condition id that covers it. The engine rejects a `pass` while any acceptance statement is uncovered.
- `instruction` — required on a `fail`: the concrete changes the next implementation round must make.

A complete pass is approved by code and moves the ticket straight to human approval; there is no separate verification session.

## The plan's conditions

{{done_when}}
