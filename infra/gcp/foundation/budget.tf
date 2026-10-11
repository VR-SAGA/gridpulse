# Cost guardrails.
#
# A GCP budget only ALERTS, it never stops spending. So budget notifications
# go to Pub/Sub, and a small function unlinks billing from the project once
# actual spend reaches the budget. That stops every paid resource: a hard
# cost circuit breaker for a portfolio project.

resource "google_pubsub_topic" "budget" {
  name   = "gridpulse-budget-alerts"
  labels = var.labels

  depends_on = [google_project_service.this]
}

resource "google_billing_budget" "monthly" {
  billing_account = var.billing_account_id
  display_name    = "gridpulse-monthly"

  budget_filter {
    projects               = ["projects/${data.google_project.this.number}"]
    credit_types_treatment = "INCLUDE_ALL_CREDITS"
  }

  amount {
    specified_amount {
      currency_code = var.budget_currency
      units         = tostring(var.budget_amount)
    }
  }

  threshold_rules {
    threshold_percent = 0.2
  }
  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 1.0
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  all_updates_rule {
    pubsub_topic   = google_pubsub_topic.budget.id
    schema_version = "1.0"
    # Keep the default e-mails to billing admins as well.
    disable_default_iam_recipients = false
  }
}

# ---------------------------------------------------------------------------
# Kill switch function (Cloud Run functions, 2nd gen)
# ---------------------------------------------------------------------------

resource "google_service_account" "kill_switch" {
  count        = var.enable_kill_switch ? 1 : 0
  account_id   = "gridpulse-kill-switch"
  display_name = "GridPulse budget kill switch"
}

# Project Billing Manager can unlink billing from this project only.
resource "google_project_iam_member" "kill_switch_billing" {
  count   = var.enable_kill_switch ? 1 : 0
  project = var.project_id
  role    = "roles/billing.projectManager"
  member  = "serviceAccount:${google_service_account.kill_switch[0].email}"
}

resource "google_project_iam_member" "kill_switch_trigger" {
  for_each = var.enable_kill_switch ? toset(["roles/run.invoker", "roles/eventarc.eventReceiver"]) : toset([])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.kill_switch[0].email}"
}

data "archive_file" "kill_switch" {
  type        = "zip"
  source_dir  = "${path.module}/../../../functions/budget-kill-switch"
  output_path = "${path.module}/.build/budget-kill-switch.zip"
}

# us-central1 keeps this bucket inside the Cloud Storage Free Tier.
resource "google_storage_bucket" "functions_src" {
  count                       = var.enable_kill_switch ? 1 : 0
  name                        = "${var.project_id}-gridpulse-functions"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = true
  labels                      = var.labels

  lifecycle_rule {
    condition {
      age = 30
    }
    action {
      type = "Delete"
    }
  }
}

resource "google_storage_bucket_object" "kill_switch_src" {
  count  = var.enable_kill_switch ? 1 : 0
  name   = "budget-kill-switch-${data.archive_file.kill_switch.output_md5}.zip"
  bucket = google_storage_bucket.functions_src[0].name
  source = data.archive_file.kill_switch.output_path
}

resource "google_cloudfunctions2_function" "kill_switch" {
  count       = var.enable_kill_switch ? 1 : 0
  name        = "gridpulse-budget-kill-switch"
  location    = var.region
  description = "Unlinks billing when spend reaches the budget"
  labels      = var.labels

  build_config {
    runtime     = "python312"
    entry_point = "handle_budget"
    source {
      storage_source {
        bucket = google_storage_bucket.functions_src[0].name
        object = google_storage_bucket_object.kill_switch_src[0].name
      }
    }
  }

  service_config {
    max_instance_count    = 1
    available_memory      = "256M"
    timeout_seconds       = 60
    service_account_email = google_service_account.kill_switch[0].email
    environment_variables = {
      TARGET_PROJECT_ID = var.project_id
      DRY_RUN           = tostring(var.kill_switch_dry_run)
    }
  }

  event_trigger {
    trigger_region        = var.region
    event_type            = "google.cloud.pubsub.topic.v1.messagePublished"
    pubsub_topic          = google_pubsub_topic.budget.id
    retry_policy          = "RETRY_POLICY_RETRY"
    service_account_email = google_service_account.kill_switch[0].email
  }

  depends_on = [
    google_project_iam_member.kill_switch_billing,
    google_project_iam_member.kill_switch_trigger,
  ]
}
