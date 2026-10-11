# Service stack: applied by GitHub Actions on every merge to main.

data "google_service_account" "runtime" {
  account_id = "gridpulse-run"
}

resource "google_cloud_run_v2_service" "api" {
  name                = "gridpulse-api"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false
  labels              = var.labels

  template {
    service_account                  = data.google_service_account.runtime.email
    max_instance_request_concurrency = 80
    timeout                          = "30s"
    labels                           = var.labels

    scaling {
      min_instance_count = 0 # scale to zero: no idle cost
      max_instance_count = var.max_instances
    }

    containers {
      image = var.image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
        # Request-based billing: CPU is only allocated during requests,
        # which is what the Cloud Run Free Tier counts.
        cpu_idle          = true
        startup_cpu_boost = false
      }

      startup_probe {
        http_get {
          path = "/healthz"
        }
        period_seconds    = 2
        failure_threshold = 10
      }

      liveness_probe {
        http_get {
          path = "/healthz"
        }
        period_seconds = 30
      }
    }
  }

  lifecycle {
    # Chaos experiments change env vars with gcloud (see chaos.yml).
    # Terraform must not silently undo a running experiment.
    ignore_changes = [
      client,
      client_version,
      template[0].containers[0].env,
    ]
  }
}

# Public endpoint so the Cloudflare edge probes and the k6 test can reach it.
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.api.name
  location = google_cloud_run_v2_service.api.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}
