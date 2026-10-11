# Cloud Monitoring SLOs and multi-window burn-rate alerts, generated from
# config/slos.json so the edge (Cloudflare) and the platform (GCP) agree
# on the same objectives.
#
# GCP measures the server side using Cloud Run's built-in request metrics,
# which are free. The Worker measures the client side from the edge.
# Comparing the two is a useful debugging signal: if the edge sees errors
# that Cloud Run does not, the problem is in front of the service.

locals {
  config = jsondecode(file("${path.module}/../../../config/slos.json"))

  gcp_targets = toset([for t in local.config.targets : t.id if t.on_gcp])
  slos        = { for s in local.config.slos : s.id => s if contains(local.gcp_targets, s.target) }
  rules       = { for r in local.config.alerting.rules : r.name => r }

  seconds = { "5m" = 300, "30m" = 1800, "1h" = 3600, "6h" = 21600, "3d" = 259200 }

  run_filter = join(" AND ", [
    "resource.type=\"cloud_run_revision\"",
    "resource.label.\"service_name\"=\"${google_cloud_run_v2_service.api.name}\"",
  ])

  # One alert policy per (SLO, rule) pair.
  alerts = {
    for pair in setproduct(keys(local.slos), keys(local.rules)) :
    "${pair[0]}-${pair[1]}" => { slo = pair[0], rule = pair[1] }
  }
}

resource "google_monitoring_custom_service" "api" {
  service_id   = "gridpulse-api"
  display_name = "GridPulse API"
}

resource "google_monitoring_slo" "this" {
  for_each = local.slos

  service             = google_monitoring_custom_service.api.service_id
  slo_id              = each.key
  display_name        = each.value.description
  goal                = each.value.objective
  rolling_period_days = each.value.window_days

  request_based_sli {
    dynamic "good_total_ratio" {
      for_each = each.value.type == "availability" ? [1] : []
      content {
        bad_service_filter = join(" AND ", [
          "metric.type=\"run.googleapis.com/request_count\"",
          local.run_filter,
          "metric.label.\"response_code_class\"=\"5xx\"",
        ])
        total_service_filter = join(" AND ", [
          "metric.type=\"run.googleapis.com/request_count\"",
          local.run_filter,
        ])
      }
    }

    dynamic "distribution_cut" {
      for_each = each.value.type == "latency" ? [1] : []
      content {
        distribution_filter = join(" AND ", [
          "metric.type=\"run.googleapis.com/request_latencies\"",
          local.run_filter,
        ])
        range {
          max = each.value.threshold_ms
        }
      }
    }
  }
}

resource "google_monitoring_notification_channel" "email" {
  count        = var.alert_email == "" ? 0 : 1
  display_name = "GridPulse on-call"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
}

resource "google_monitoring_alert_policy" "burn_rate" {
  for_each = local.alerts

  display_name = "[${upper(local.rules[each.value.rule].severity)}] ${each.value.slo} ${each.value.rule}"
  combiner     = "AND" # both windows must exceed the burn rate
  severity     = local.rules[each.value.rule].severity == "page" ? "CRITICAL" : "WARNING"

  dynamic "conditions" {
    for_each = ["long", "short"]
    content {
      display_name = "Burn rate > ${local.rules[each.value.rule].burn_rate}x over ${local.rules[each.value.rule][conditions.value]}"
      condition_threshold {
        filter          = "select_slo_burn_rate(\"${google_monitoring_slo.this[each.value.slo].name}\", \"${local.seconds[local.rules[each.value.rule][conditions.value]]}s\")"
        comparison      = "COMPARISON_GT"
        threshold_value = local.rules[each.value.rule].burn_rate
        duration        = "0s"
      }
    }
  }

  notification_channels = google_monitoring_notification_channel.email[*].id

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      SLO **${each.value.slo}** is burning error budget at more than
      ${local.rules[each.value.rule].burn_rate}x the sustainable rate
      (${local.rules[each.value.rule].budget_spent} of the monthly budget).

      Runbook: https://github.com/VR-SAGA/gridpulse/blob/main/docs/runbook.md
    EOT
  }

  user_labels = var.labels
}
