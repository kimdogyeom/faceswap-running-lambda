import os
import time
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Tuple

import boto3
from boto3.dynamodb.conditions import Key

dynamodb = boto3.resource("dynamodb")

PUBLIC_METRICS_TABLE_NAME = os.environ["PUBLIC_METRICS_TABLE_NAME"]
PUBLIC_METRICS_PK = "PUBLIC_DASHBOARD"
PUBLIC_METRICS_RETENTION_SECONDS = 8 * 24 * 60 * 60
BUCKET_SECONDS = 60 * 60

public_metrics_table = dynamodb.Table(PUBLIC_METRICS_TABLE_NAME)


def current_bucket_start(timestamp: int | None = None) -> int:
    value = int(time.time() if timestamp is None else timestamp)
    return value - (value % BUCKET_SECONDS)


def bucket_range(hours: int = 24, timestamp: int | None = None) -> Tuple[int, int]:
    end_bucket = current_bucket_start(timestamp)
    start_bucket = end_bucket - ((hours - 1) * BUCKET_SECONDS)
    return start_bucket, end_bucket


def bucket_starts(hours: int = 24, timestamp: int | None = None) -> List[int]:
    start_bucket, _ = bucket_range(hours=hours, timestamp=timestamp)
    return [start_bucket + (offset * BUCKET_SECONDS) for offset in range(hours)]


def bucket_start_to_iso(bucket_start: int) -> str:
    return datetime.fromtimestamp(bucket_start, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def increment_public_metrics(
    created_delta: int = 0,
    completed_delta: int = 0,
    failed_delta: int = 0,
    failure_code: str | None = None,
    timestamp: int | None = None,
):
    now = int(time.time() if timestamp is None else timestamp)
    bucket_start = current_bucket_start(now)
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

    if created_delta:
        expression_values[":createdDelta"] = created_delta
        update_parts.append("createdCount = if_not_exists(createdCount, :zero) + :createdDelta")

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


def _to_int(value: Any) -> int:
    if isinstance(value, Decimal):
        return int(value)
    return int(value or 0)


def _normalize_failure_counts(raw: Dict[str, Any] | None) -> Dict[str, int]:
    normalized: Dict[str, int] = {}
    for key, value in (raw or {}).items():
        normalized[key] = _to_int(value)
    return normalized


def query_public_metrics(hours: int = 24, timestamp: int | None = None) -> List[Dict[str, Any]]:
    start_bucket, end_bucket = bucket_range(hours=hours, timestamp=timestamp)
    items: Dict[int, Dict[str, Any]] = {}
    query_kwargs = {
        "KeyConditionExpression": Key("pk").eq(PUBLIC_METRICS_PK) & Key("sk").between(start_bucket, end_bucket)
    }

    while True:
        response = public_metrics_table.query(**query_kwargs)
        for item in response.get("Items", []):
            bucket_start = _to_int(item["sk"])
            items[bucket_start] = {
                "bucketStart": bucket_start,
                "bucketStartIso": bucket_start_to_iso(bucket_start),
                "createdCount": _to_int(item.get("createdCount")),
                "completedCount": _to_int(item.get("completedCount")),
                "failedCount": _to_int(item.get("failedCount")),
                "failureCounts": _normalize_failure_counts(item.get("failureCounts")),
            }
        if "LastEvaluatedKey" not in response:
            break
        query_kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]

    rows: List[Dict[str, Any]] = []
    for bucket_start in bucket_starts(hours=hours, timestamp=timestamp):
        rows.append(
            items.get(
                bucket_start,
                {
                    "bucketStart": bucket_start,
                    "bucketStartIso": bucket_start_to_iso(bucket_start),
                    "createdCount": 0,
                    "completedCount": 0,
                    "failedCount": 0,
                    "failureCounts": {},
                },
            )
        )
    return rows
