terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.0, < 8.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # Bucket is passed at init time:
  #   terraform init -backend-config="bucket=<project-id>-tfstate"
  backend "gcs" {
    prefix = "gridpulse/foundation"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region

  # The Billing Budgets API needs a quota project when you run with user
  # credentials (gcloud auth application-default login).
  user_project_override = true
  billing_project       = var.project_id
}
