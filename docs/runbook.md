# Runbook: GridPulse API

Linked from every burn-rate alert (Cloud Monitoring and GitHub incident issues).

## 1. Triage (first 5 minutes)

1. **Acknowledge.** Assign yourself on the incident issue. You are Incident Commander until you hand over.
2. **Is it real?** Compare both views:
   - Edge view: [status page](../README.md#live-links), `/metrics`, the incident issue.
   - Platform view: Cloud Monitoring > Services > GridPulse API > SLOs.
   - Edge errors but Cloud Run clean: the problem is in front of the service (DNS, TLS, Google front end, Cloudflare). Both bad: the service itself.
3. **What changed?** Check the Actions tab for the last `deploy-gcp`, `chaos` and `loadtest` runs. Most incidents follow a change.

## 2. Mitigate first, diagnose second

| Symptom | Mitigation |
|---|---|
| A chaos experiment is running | Run the `chaos` workflow with `error_rate=0`, `latency_ms=0`, `duration_minutes=0` |
| Errors started after a deploy | Roll back: `gcloud run services update-traffic gridpulse-api --region us-central1 --to-revisions <previous>=100` |
| Latency high at load | Check instance count against `max_instances` (2). Saturation is expected at the ceiling: the fix is capacity, not code |
| Upstream (carbon API) failing | Nothing to roll back. Confirm on their status, note it in the issue, let the ticket-level alert track it |

## 3. Diagnose

```bash
# Recent errors
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="gridpulse-api" AND severity>=ERROR' \
  --limit 50 --freshness 1h --format 'value(timestamp, jsonPayload.httpRequest.status, jsonPayload.message)'

# Revisions, traffic split and env vars (chaos settings live in env)
gcloud run services describe gridpulse-api --region us-central1

# Client-side timing breakdown
curl -s -o /dev/null -w 'dns %{time_namelookup}s  connect %{time_connect}s  tls %{time_appconnect}s  ttfb %{time_starttransfer}s  total %{time_total}s\n' \
  "$API_URL/api/tariff"
```

## 4. Close out

- The Worker closes the issue after 15 minutes without a matching burn-rate rule.
- Write a postmortem from [the template](postmortems/TEMPLATE.md) within 5 working days, store it in `docs/postmortems/`, and link it from the issue.
- Every action item gets an owner, a due date and its own issue.
