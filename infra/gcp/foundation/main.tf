# Foundation stack: long-lived, rarely changed, applied by a human.
# It creates the identities and guardrails that the CI-applied service
# stack runs with, so CI never needs project-owner rights.

data "google_project" "this" {}

locals {
  services = [
    "artifactregistry.googleapis.com",
    "billingbudgets.googleapis.com",
    "cloudbilling.googleapis.com",
    "cloudbuild.googleapis.com",
    "cloudfunctions.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "eventarc.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "pubsub.googleapis.com",
    "run.googleapis.com",
    "serviceusage.googleapis.com",
    "storage.googleapis.com",
    "sts.googleapis.com",
  ]
}

resource "google_project_service" "this" {
  for_each           = toset(local.services)
  service            = each.value
  disable_on_destroy = false
}

# ---------------------------------------------------------------------------
# Container registry with a cleanup policy, so old images never push us
# past the 0.5 GB Free Tier.
# ---------------------------------------------------------------------------
resource "google_artifact_registry_repository" "images" {
  repository_id = "gridpulse"
  location      = var.region
  format        = "DOCKER"
  description   = "GridPulse container images"
  labels        = var.labels

  cleanup_policy_dry_run = false

  cleanup_policies {
    id     = "keep-last-3"
    action = "KEEP"
    most_recent_versions {
      keep_count = 3
    }
  }

  cleanup_policies {
    id     = "delete-older-than-7d"
    action = "DELETE"
    condition {
      tag_state  = "ANY"
      older_than = "604800s"
    }
  }

  depends_on = [google_project_service.this]
}

# ---------------------------------------------------------------------------
# Service accounts
# ---------------------------------------------------------------------------

# Identity the Cloud Run service runs as. It needs no data access at all.
resource "google_service_account" "runtime" {
  account_id   = "gridpulse-run"
  display_name = "GridPulse Cloud Run runtime"
}

resource "google_project_iam_member" "runtime_logs" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

# Identity GitHub Actions impersonates. Least privilege: it can deploy the
# service and manage monitoring, but cannot touch IAM, billing or this stack.
resource "google_service_account" "deployer" {
  account_id   = "gridpulse-deployer"
  display_name = "GridPulse GitHub Actions deployer"
}

resource "google_project_iam_member" "deployer" {
  for_each = toset([
    "roles/run.admin",
    "roles/monitoring.editor",
    "roles/serviceusage.serviceUsageConsumer",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_artifact_registry_repository_iam_member" "deployer_push" {
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}

# Deployer may attach the runtime SA to Cloud Run, and nothing else.
resource "google_service_account_iam_member" "deployer_acts_as_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

# Deployer reads and writes Terraform state for the service stack only.
resource "google_storage_bucket_iam_member" "deployer_state" {
  bucket = var.tfstate_bucket
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.deployer.email}"

  condition {
    title      = "service-stack-state-only"
    expression = "resource.name.startsWith(\"projects/_/buckets/${var.tfstate_bucket}/objects/gridpulse/service\")"
  }
}

# Listing the bucket is needed for state locking and cannot be scoped by prefix.
resource "google_storage_bucket_iam_member" "deployer_state_list" {
  bucket = var.tfstate_bucket
  role   = "roles/storage.legacyBucketReader"
  member = "serviceAccount:${google_service_account.deployer.email}"
}

# ---------------------------------------------------------------------------
# Workload Identity Federation: GitHub OIDC tokens, no long-lived keys.
# ---------------------------------------------------------------------------
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
  depends_on                = [google_project_service.this]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  # Reject tokens from any other repository, even within the same owner.
  attribute_condition = "assertion.repository == \"${var.github_repo}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_impersonates_deployer" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}
