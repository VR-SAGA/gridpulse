# Postmortem: <short title>

> Blameless: we look at how the system and process allowed this, not who made a mistake.

| | |
|---|---|
| **Incident issue** | #<number> |
| **Date** | YYYY-MM-DD |
| **Duration** | detected HH:MM, mitigated HH:MM, resolved HH:MM (UTC) |
| **Severity** | page / ticket |
| **SLOs affected** | e.g. `api-availability` |
| **Error budget consumed** | e.g. 18% of the 28-day budget |
| **Authors** | |

## Summary

Two or three sentences: what users experienced, for how long, and why.

## Impact

- Requests affected (share and count), from Cloud Monitoring and the edge probes.
- Error budget before and after.

## Timeline (UTC)

| Time | Event |
|---|---|
| HH:MM | Trigger (deploy, chaos run, upstream change) |
| HH:MM | First failed probe |
| HH:MM | Alert fired (which rule, which windows) |
| HH:MM | Acknowledged |
| HH:MM | Mitigation applied |
| HH:MM | Recovered |

**Time to detect:** __ min. **Time to mitigate:** __ min.

## Contributing factors

Not a single root cause. List the conditions that combined to cause the impact.

1.
2.

## What went well

-

## What went badly

-

## Where we got lucky

-

## Action items

| Action | Type (prevent / detect / mitigate) | Owner | Due | Issue |
|---|---|---|---|---|
| | | | | |

## Detection review

- Did the right burn-rate rule fire? Too early (noise) or too late?
- Did edge and platform views agree? If not, why?
