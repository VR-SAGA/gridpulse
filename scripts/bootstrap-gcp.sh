#!/usr/bin/env bash
# One-time bootstrap: run once from your laptop (or Cloud Shell) as a
# project owner. Creates the Terraform state bucket and applies the
# foundation stack, then prints the values to paste into GitHub.
#
# Usage: scripts/bootstrap-gcp.sh <project-id> <billing-account-id>
set -euo pipefail

PROJECT_ID="${1:?project id required}"
BILLING_ACCOUNT="${2:?billing account id required (gcloud billing accounts list)}"
REGION="us-central1" # Free Tier region for Cloud Run and Cloud Storage
BUCKET="${PROJECT_ID}-tfstate"

gcloud config set project "$PROJECT_ID" >/dev/null

echo "==> Checking billing is linked"
gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' | grep -q True \
  || gcloud billing projects link "$PROJECT_ID" --billing-account "$BILLING_ACCOUNT"

echo "==> Enabling APIs Terraform needs to start"
gcloud services enable storage.googleapis.com cloudresourcemanager.googleapis.com \
  serviceusage.googleapis.com iam.googleapis.com billingbudgets.googleapis.com

echo "==> Creating state bucket gs://${BUCKET} (versioned, uniform access)"
if ! gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUCKET}" --location "$REGION" \
    --uniform-bucket-level-access --public-access-prevention
  gcloud storage buckets update "gs://${BUCKET}" --versioning
fi

echo "==> Applying foundation stack"
cd "$(dirname "$0")/../infra/gcp/foundation"
terraform init -input=false -backend-config="bucket=${BUCKET}"
terraform apply -input=false \
  -var "project_id=${PROJECT_ID}" \
  -var "billing_account_id=${BILLING_ACCOUNT}" \
  -var "tfstate_bucket=${BUCKET}"

cat <<EOF

==> Done. Add these as GitHub repository variables (Settings > Secrets and variables > Actions > Variables):

  GCP_PROJECT_ID                  ${PROJECT_ID}
  TF_STATE_BUCKET                 ${BUCKET}
  GCP_WORKLOAD_IDENTITY_PROVIDER  $(terraform output -raw workload_identity_provider)
  GCP_DEPLOYER_SA                 $(terraform output -raw deployer_service_account)
  ALERT_EMAIL                     <your e-mail for Cloud Monitoring alerts>

Then push to main (or run the deploy-gcp workflow) to deploy the API.
EOF
