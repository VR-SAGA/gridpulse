"""Budget kill switch.

Triggered by Cloud Billing budget notifications on Pub/Sub. When actual
spend reaches the budget, it unlinks the billing account from the project,
which stops all paid resources. Re-link billing in the console to recover.

Message format:
https://cloud.google.com/billing/docs/how-to/budgets-programmatic-notifications
"""

import base64
import json
import logging
import os

import functions_framework
from google.cloud import billing_v1

PROJECT_ID = os.environ["TARGET_PROJECT_ID"]
DRY_RUN = os.environ.get("DRY_RUN", "false").lower() == "true"

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("kill-switch")


def should_disable(notification: dict) -> bool:
    """True when actual cost has reached the budget amount."""
    cost = float(notification.get("costAmount", 0))
    budget = float(notification.get("budgetAmount", 0))
    return budget > 0 and cost >= budget


@functions_framework.cloud_event
def handle_budget(cloud_event):
    raw = cloud_event.data["message"]["data"]
    notification = json.loads(base64.b64decode(raw).decode("utf-8"))
    log.info(
        "budget notification: cost=%s budget=%s %s",
        notification.get("costAmount"),
        notification.get("budgetAmount"),
        notification.get("currencyCode"),
    )

    if not should_disable(notification):
        return

    client = billing_v1.CloudBillingClient()
    name = f"projects/{PROJECT_ID}"
    info = client.get_project_billing_info(name=name)
    if not info.billing_enabled:
        log.info("billing already disabled for %s", PROJECT_ID)
        return

    if DRY_RUN:
        log.warning("DRY RUN: would disable billing for %s", PROJECT_ID)
        return

    client.update_project_billing_info(
        name=name,
        project_billing_info=billing_v1.ProjectBillingInfo(billing_account_name=""),
    )
    log.critical("billing disabled for %s: budget exceeded", PROJECT_ID)
