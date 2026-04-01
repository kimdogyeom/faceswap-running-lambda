import json
import os
import urllib.request

import boto3

secrets_client = boto3.client("secretsmanager")

DISCORD_WEBHOOK_SECRET_ARN = os.environ["DISCORD_WEBHOOK_SECRET_ARN"]
SITE_URL = os.environ.get("SITE_URL", "")


def _load_webhook_url() -> str:
    response = secrets_client.get_secret_value(SecretId=DISCORD_WEBHOOK_SECRET_ARN)
    secret_string = response.get("SecretString") or ""
    if not secret_string:
        raise RuntimeError("Discord webhook secret is empty")

    try:
        parsed = json.loads(secret_string)
    except json.JSONDecodeError:
        return secret_string

    for key in ("url", "webhook", "webhook_url"):
        value = parsed.get(key)
        if value:
            return value
    raise RuntimeError("Discord webhook secret must contain url, webhook, or webhook_url")


def _format_message(message: str) -> str:
    try:
        payload = json.loads(message)
    except json.JSONDecodeError:
        return message

    lines = [
        f"[{payload.get('NewStateValue', 'UNKNOWN')}] {payload.get('AlarmName', 'Alarm notification')}",
        payload.get("NewStateReason", "No reason supplied."),
    ]

    if payload.get("Region"):
        lines.append(f"Region: {payload['Region']}")
    if payload.get("AWSAccountId"):
        lines.append(f"Account: {payload['AWSAccountId']}")
    if SITE_URL:
        lines.append(f"Site: {SITE_URL}")
    return "\n".join(lines)


def handler(event, _context):
    webhook_url = _load_webhook_url()

    for record in event.get("Records", []):
        message = record.get("Sns", {}).get("Message", "")
        payload = {"content": _format_message(message)}
        request = urllib.request.Request(
            webhook_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            response.read()

    return {"ok": True}
