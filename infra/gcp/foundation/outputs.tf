output "workload_identity_provider" {
  description = "Set as the GCP_WORKLOAD_IDENTITY_PROVIDER repository variable in GitHub."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "deployer_service_account" {
  description = "Set as the GCP_DEPLOYER_SA repository variable in GitHub."
  value       = google_service_account.deployer.email
}

output "runtime_service_account" {
  value = google_service_account.runtime.email
}

output "image_repository" {
  description = "Docker repository path for images."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}
