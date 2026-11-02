Your job is to gather enough information about the described ticket needed to implement it completely autonomously. You should not make any changes, merely gather information to help formulate a plan. Given this initial ticket state:

{{ticket_state}}

Every `done_when` condition you plan must be verifiable by an agent without human input: a command an agent can run or an observable it can read. Never write a condition that requires a human action, visual confirmation, a production restart, or confirmation "on the ticket" — human approval is already implicit for every ticket (a passing review moves the ticket straight to a human), so a condition only a human could evidence is a gap in the plan, not a safeguard. When the real acceptance is human judgement, plan the strongest agent-verifiable proxy for it — tests, a lab smoke, a grep or `git ls-remote` check — and leave the judgement itself to the implicit approval step.

grill yourself with questions until you feel like you gathered enough information to generate a complete plan. Use your best judgement whenever you reach a decision point. When you're done, call the `kanban_submit_plan` tool.
