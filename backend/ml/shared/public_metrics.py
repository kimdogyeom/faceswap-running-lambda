import os
import time
from typing import Any, Dict

import boto3

dynamodb = boto3.resource("dynamodb")

PUBLIC_METRICS_TABLE_NAME = os.environ["PUBLIC_METRICS_TABLE_NAME"]
PUBLIC_METRICS_PK = "PUBLIC_DASHBOARD"
PUBLIC_METRICS_RETENTION_SECONDS = 8 * 24 * 60 * 60
BUCKET_SECONDS = 60 * 60

public_metrics_table = dynamodb.Table(PUBLIC_METRICS_TABLE_NAME)


def _current_bucket_start(timestamp: int | None = None) -> int:
    value = int(time.time() if timestamp is None else timestamp)
    return value - (value % BUCKET_SECONDS)


def increment_public_metrics(
    completed_delta: int = 0,
    failed_delta: int = 0,
    failure_code: str | None = None,
    timestamp: int | None = None,
):
    now = int(time.time() if timestamp is None else timestamp)
    bucket_start = _current_bucket_start(now)
    expression_values: Dict[str, Any] = {
        ":updatedAt": now,
        ":ttl": now + PUBLIC_METRICS_RETENTION_SECONDS,
        ":zero": 0,
        ":emptyMap": {},
    }
    update_parts = [
        "updatedAt = :updatedAt",
        "ttl = :ttl",
    ]

    if completed_delta:
        expression_values[":completedDelta"] = completed_delta
        update_parts.append("completedCount = if_not_exists(completedCount, :zero) + :completedDelta")

    if failed_delta:
        expression_values[":failedDelta"] = failed_delta
        update_parts.append("failedCount = if_not_exists(failedCount, :zero) + :failedDelta")

    if failure_code:
        update_parts.append("failureCounts = if_not_exists(failureCounts, :emptyMap)")

    public_metrics_table.update_item(
        Key={"pk": PUBLIC_METRICS_PK, "sk": bucket_start},
        UpdateExpression="SET " + ", ".join(update_parts),
        ExpressionAttributeValues=expression_values,
    )

    if failure_code:
        public_metrics_table.update_item(
            Key={"pk": PUBLIC_METRICS_PK, "sk": bucket_start},
            UpdateExpression=(
                "SET updatedAt = :updatedAt, ttl = :ttl, "
                "#failureCounts.#failureCode = if_not_exists(#failureCounts.#failureCode, :zero) + :failedDelta"
            ),
            ExpressionAttributeNames={
                "#failureCounts": "failureCounts",
                "#failureCode": failure_code,
            },
            ExpressionAttributeValues={
                ":updatedAt": now,
                ":ttl": now + PUBLIC_METRICS_RETENTION_SECONDS,
                ":zero": 0,
                ":failedDelta": failed_delta or 1,
            },
        )
