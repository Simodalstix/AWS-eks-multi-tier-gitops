# Runbook: symptom as the user sees it

Alert: alert name, or manual report
Severity: SEV2
Spine: first layer to check

## Detect

- Signal that fires, and where it shows.
- Command that confirms it is real.

## Triage

- Scope: one pod, one node, all users?
- Since when. What changed: deploy, Argo CD sync, node rotation.

## Mitigate

- Fastest action that restores service, even if it hides the cause.

## Diagnose

- Spine layer to start at, and the check for it.
- What rules each candidate cause in or out.

## Fix

- Permanent change, and where it lands: Git, Terraform, chart values.

## Postmortem

- Date: YYYY-MM-DD
- Duration: detect to resolved
- Impact: who, what, how much
- Detected by: alert, user, chance
- Trigger: the change or event
- Root cause: why the trigger hurt
- Mitigation: what stopped the bleeding
- Fix: the permanent change
- Lesson: one line
- Follow-up: owner and date
