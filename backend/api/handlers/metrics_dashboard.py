import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict

import boto3

from .common import json_response
from .observability import log_event
from .public_metrics import query_public_metrics

cloudwatch_client = boto3.client("cloudwatch")

METRIC_NAMESPACE = os.environ["METRIC_NAMESPACE"]
API_NAME = os.environ["API_NAME"]
WORKER_FUNCTION_NAME = os.environ["WORKER_FUNCTION_NAME"]
JOB_QUEUE_NAME = os.environ["JOB_QUEUE_NAME"]


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _isoformat(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    return float(value)


def _get_first_value(result: Dict[str, Any] | None) -> float | None:
    if not result:
        return None
    values = result.get("Values") or []
    if not values:
        return None
    return _to_float(values[0])


def _fetch_cloudwatch_metrics(now: datetime) -> Dict[str, float | None]:
    day_start = now - timedelta(hours=24)
    response = cloudwatch_client.get_metric_data(
        MetricDataQueries=[
            {
                "Id": "jobavg24h",
                "MetricStat": {
                    "Metric": {
                        "Namespace": METRIC_NAMESPACE,
                        "MetricName": "JobTotalDurationMs",
                    },
                    "Period": 24 * 60 * 60,
                    "Stat": "Average",
                },
                "ReturnData": True,
            },
            {
                "Id": "jobp95day",
                "MetricStat": {
                    "Metric": {
                        "Namespace": METRIC_NAMESPACE,
                        "MetricName": "JobTotalDurationMs",
                    },
                    "Period": 24 * 60 * 60,
                    "Stat": "p95",
                },
                "ReturnData": True,
            },
            {
                "Id": "jobp95hour",
                "MetricStat": {
                    "Metric": {
                        "Namespace": METRIC_NAMESPACE,
                        "MetricName": "JobTotalDurationMs",
                    },
                    "Period": 60 * 60,
                    "Stat": "p95",
                },
                "ReturnData": True,
            },
            {
                "Id": "api5xx15m",
                "MetricStat": {
                    "Metric": {
                        "Namespace": "AWS/ApiGateway",
                        "MetricName": "5XXError",
                        "Dimensions": [
                            {"Name": "ApiName", "Value": API_NAME},
                        ],
                    },
                    "Period": 15 * 60,
                    "Stat": "Sum",
                },
                "ReturnData": True,
            },
            {
                "Id": "workererrors15m",
                "MetricStat": {
                    "Metric": {
                        "Namespace": "AWS/Lambda",
                        "MetricName": "Errors",
                        "Dimensions": [
                            {"Name": "FunctionName", "Value": WORKER_FUNCTION_NAME},
                        ],
                    },
                    "Period": 15 * 60,
                    "Stat": "Sum",
                },
                "ReturnData": True,
            },
            {
                "Id": "queueage15m",
                "MetricStat": {
                    "Metric": {
                        "Namespace": "AWS/SQS",
                        "MetricName": "ApproximateAgeOfOldestMessage",
                        "Dimensions": [
                            {"Name": "QueueName", "Value": JOB_QUEUE_NAME},
                        ],
                    },
                    "Period": 15 * 60,
                    "Stat": "Maximum",
                },
                "ReturnData": True,
            },
        ],
        StartTime=day_start,
        EndTime=now,
        ScanBy="TimestampDescending",
    )
    results = {item["Id"]: item for item in response.get("MetricDataResults", [])}
    return {
        "averageLatencyMs": _get_first_value(results.get("jobavg24h")),
        "p95LatencyMs": _get_first_value(results.get("jobp95day")),
        "statusP95LatencyMs": _get_first_value(results.get("jobp95hour")),
        "api5xx15m": _get_first_value(results.get("api5xx15m")),
        "workerErrors15m": _get_first_value(results.get("workererrors15m")),
        "queueAge15m": _get_first_value(results.get("queueage15m")),
    }


def _round_metric(value: float | None) -> float | None:
    if value is None:
        return None
    return round(value, 2)


def _compute_rates(completed: int, failed: int) -> tuple[float | None, float | None]:
    terminal = completed + failed
    if terminal == 0:
        return None, None
    return round(completed / terminal, 4), round(failed / terminal, 4)


def _build_status(
    *,
    metrics: Dict[str, float | None],
    success_rate: float | None,
    terminal_count: int,
    partial_data: bool,
    evaluated_at: datetime,
) -> Dict[str, Any]:
    api_5xx = metrics.get("api5xx15m")
    worker_errors = metrics.get("workerErrors15m")
    queue_age = metrics.get("queueAge15m")
    p95_hour = metrics.get("statusP95LatencyMs")

    if api_5xx is not None and api_5xx >= 5:
        level = "down"
        reason = "API 5XX errors breached the critical threshold in the last 15 minutes."
    elif worker_errors is not None and worker_errors >= 3:
        level = "down"
        reason = "Worker errors breached the critical threshold in the last 15 minutes."
    elif queue_age is not None and queue_age >= 300:
        level = "down"
        reason = "Queue backlog is critically delayed."
    elif p95_hour is not None and p95_hour >= 120000:
        level = "down"
        reason = "P95 processing latency is above the critical threshold."
    elif terminal_count >= 10 and success_rate is not None and success_rate < 0.8:
        level = "down"
        reason = "Recent job success rate fell below the critical threshold."
    elif api_5xx is not None and api_5xx > 0:
        level = "degraded"
        reason = "API 5XX errors were observed in the last 15 minutes."
    elif worker_errors is not None and worker_errors > 0:
        level = "degraded"
        reason = "Worker errors were observed in the last 15 minutes."
    elif queue_age is not None and queue_age >= 120:
        level = "degraded"
        reason = "Queue backlog is elevated."
    elif p95_hour is not None and p95_hour >= 90000:
        level = "degraded"
        reason = "P95 processing latency is elevated."
    elif terminal_count >= 10 and success_rate is not None and success_rate < 0.95:
        level = "degraded"
        reason = "Recent job success rate is below the healthy target."
    else:
        level = "healthy"
        reason = "Recent request volume and latency are within expected thresholds."

    if partial_data:
        reason = f"{reason} Some metrics are temporarily unavailable."

    return {
        "level": level,
        "label": level.capitalize(),
        "reason": reason,
        "evaluatedAt": _isoformat(evaluated_at),
    }


def handler(_event, context):
    request_id = getattr(context, "aws_request_id", None)
    started_at = time.perf_counter()
    now = _utc_now()
    rows = query_public_metrics(hours=24, timestamp=int(now.timestamp()))

    requests = sum(item["createdCount"] for item in rows)
    completed = sum(item["completedCount"] for item in rows)
    failed = sum(item["failedCount"] for item in rows)
    success_rate, failure_rate = _compute_rates(completed, failed)

    failure_totals: Dict[str, int] = {}
    for row in rows:
        for code, count in row["failureCounts"].items():
            failure_totals[code] = failure_totals.get(code, 0) + count

    failure_distribution = []
    failure_total_count = sum(failure_totals.values())
    for code, count in sorted(failure_totals.items(), key=lambda item: (-item[1], item[0])):
        failure_distribution.append(
            {
                "code": code,
                "count": count,
                "share": round(count / failure_total_count, 4) if failure_total_count else 0,
            }
        )

    partial_data = False
    try:
        cloudwatch_metrics = _fetch_cloudwatch_metrics(now)
    except Exception as error:
        partial_data = True
        cloudwatch_metrics = {
            "averageLatencyMs": None,
            "p95LatencyMs": None,
            "statusP95LatencyMs": None,
            "api5xx15m": None,
            "workerErrors15m": None,
            "queueAge15m": None,
        }
        log_event(
            "api.metrics_dashboard",
            "fetch_cloudwatch_metrics",
            "error",
            request_id=request_id,
            duration_ms=round((time.perf_counter() - started_at) * 1000),
            message=str(error),
        )

    payload = {
        "timeframe": {
            "windowHours": 24,
            "startAt": _isoformat(now - timedelta(hours=24)),
            "endAt": _isoformat(now),
            "granularity": "hour",
        },
        "status": _build_status(
            metrics=cloudwatch_metrics,
            success_rate=success_rate,
            terminal_count=completed + failed,
            partial_data=partial_data,
            evaluated_at=now,
        ),
        "summary": {
            "requests": requests,
            "completed": completed,
            "failed": failed,
            "successRate": success_rate,
            "failureRate": failure_rate,
            "averageLatencyMs": _round_metric(cloudwatch_metrics.get("averageLatencyMs")),
            "p95LatencyMs": _round_metric(cloudwatch_metrics.get("p95LatencyMs")),
        },
        "timeseries": [
            {
                "bucketStart": row["bucketStartIso"],
                "requests": row["createdCount"],
                "completed": row["completedCount"],
                "failed": row["failedCount"],
            }
            for row in rows
        ],
        "failureDistribution": failure_distribution,
        "partialData": partial_data,
    }

    log_event(
        "api.metrics_dashboard",
        "build_dashboard_payload",
        "success",
        request_id=request_id,
        duration_ms=round((time.perf_counter() - started_at) * 1000),
        partialData=partial_data,
        requests=requests,
        completed=completed,
        failed=failed,
    )
    return json_response(200, payload)
