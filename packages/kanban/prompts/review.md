Review the implementation of kanban ticket {{key}}: "{{title}}".

The ticket, the plan and the implementer's result are restated below; read the working tree and the diff with git before judging anything. Do not edit files. Review adversarially: assume the work is broken until you have proved otherwise, and check every `done_when` condition against the code, not against what the implementer claimed.

Then call `kanban_submit_review` with exactly these keys:

- `verdict` — `"pass"` or `"fail"`.
- `reasons` — array of strings: why you reached the verdict. A `fail` must carry at least one.
- `scope_drift` — optional string: any work outside the ticket/plan scope.
- `done_when` — one row per plan condition listed below, using the **same id**. Each row is `{id, met, confidence, evidence}`: `met` a boolean, `confidence` a number 0..1, `evidence` a concrete observable (a path, a `file:line`, a command and what it printed). The engine rejects a `pass` while any condition is missing, unmet, below the confidence threshold, has no evidence, or carries an id the plan never declared. A condition marked `(deferred to approval …)` is the human's step: report it `met: false` with evidence naming what the human checks, and if the only unmet conditions are deferred ones, the verdict is `pass` — that is the plan working, not a gap you found.
- `acceptance_coverage` — one row per **stored** acceptance statement — the human's list this session was built against, and nothing else — `{condition, acceptance}`, naming the plan condition id that covers it. The engine rejects a `pass` while any stored acceptance statement is uncovered. A sentence from the ticket body is not a stored acceptance statement: do not invent a row for one, and submit an empty array when the ticket stored none.
- `instruction` — required on a `fail`: the concrete changes the next implementation round must make.

A complete pass is approved by code and moves the ticket straight to human approval; there is no separate verification session. Deferred conditions travel with it and are listed in the approval hand-over, so passing on them costs the build nothing.

{{question_note}}

## The ticket, as the human wrote it

{{ticket_state}}

## Plan

{{plan}}

## The implementer's result

{{implementation}}

## The plan's conditions

{{done_when}}
