output "api_url" {
  description = "Public URL of the Cloud Run service. Put it into worker/wrangler.toml as API_URL."
  value       = google_cloud_run_v2_service.api.uri
}

output "slo_ids" {
  value = [for s in google_monitoring_slo.this : s.name]
}
