variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "image" {
  description = "Full image reference to deploy. CI passes the digest-pinned image it just built."
  type        = string
  # Google's public sample, so the first apply works before any image is built.
  default = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "max_instances" {
  description = "Hard ceiling on Cloud Run instances. Caps cost if a load test or bots go wild."
  type        = number
  default     = 2
}

variable "alert_email" {
  description = "E-mail address for Cloud Monitoring burn-rate alerts. Empty disables the channel."
  type        = string
  default     = ""
}

variable "labels" {
  type = map(string)
  default = {
    app         = "gridpulse"
    managed-by  = "terraform"
    cost-center = "portfolio"
  }
}
