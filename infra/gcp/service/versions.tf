terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.0, < 8.0"
    }
  }

  # terraform init -backend-config="bucket=<project-id>-tfstate"
  backend "gcs" {
    prefix = "gridpulse/service"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
