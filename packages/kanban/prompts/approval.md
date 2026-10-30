Review passed for kanban ticket {{key}}: "{{title}}".

This session now carries the approval stage: the work is done and parked for the human. Summarize what was built, what the review verified, and anything still open, then ask what they want to do.

- `kanban_approve` closes the ticket as done.
- `kanban_discard` closes it without approving.
- `kanban_submit_plan` sends the ticket back for another build/review round with the plan you submit.

Do not call any of those three until the human explicitly asks. Inspect, merge, deploy or iterate only when they ask for it.

## Acceptance

{{acceptance}}

## Plan

{{plan}}

## Review

{{review}}
