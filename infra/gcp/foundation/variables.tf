variable "project_id" {
  description = "GCP project ID that hosts GridPulse."
  type        = string
}

variable "region" {
  description = "Region for all resources. us-central1 keeps Cloud Run and Cloud Storage inside the Free Tier."
  type        = string
  default     = "us-central1"
}

variable "github_repo" {
  description = "GitHub repository (owner/name) allowed to deploy through Workload Identity Federation."
  type        = string
  default     = "VR-SAGA/gridpulse"
}

variable "tfstate_bucket" {
  description = "Name of the Terraform state bucket created by scripts/bootstrap-gcp.sh."
  type        = string
}

variable "billing_account_id" {
  description = "Billing account ID (XXXXXX-XXXXXX-XXXXXX). Used for the budget and kill switch."
  type        = string
}

variable "budget_currency" {
  description = "Currency of the billing account. Must match the account, otherwise the budget API rejects it."
  type        = string
  default     = "EUR"
}

variable "budget_amount" {
  description = "Monthly budget in whole currency units. Alerts at 20%, 50% and 100%."
  type        = number
  default     = 5
}

variable "enable_kill_switch" {
  description = "Deploy a function that unlinks billing from the project when spend reaches the budget. Stops ALL paid resources."
  type        = bool
  default     = true
}

variable "kill_switch_dry_run" {
  description = "If true, the kill switch only logs what it would do."
  type        = bool
  default     = false
}

variable "labels" {
  description = "Labels applied to every labelable resource, for cost showback."
  type        = map(string)
  default = {
    app         = "gridpulse"
    managed-by  = "terraform"
    cost-center = "portfolio"
  }
}
