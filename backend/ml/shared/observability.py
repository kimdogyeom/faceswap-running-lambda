import json
import os
from typing import Any, Dict

import boto3

cloudwatch_client = boto3.client("cloudwatch")

METRIC_NAMESPACE = os.environ.get("METRIC_NAMESPACE", "FaceSwapService")


def log_event(
    service: str,
    stage: str,
    status: str,
    request_id: str | None = None,
    job_id: str | None = None,
    duration_ms: int | None = None,
    **extra: Any,
):
    payload: Dict[str, Any] = {
        "service": service,
        "stage": stage,
        "status": status,
    }
    if request_id:
        payload["requestId"] = request_id
    if job_id:
        payload["jobId"] = job_id
    if duration_ms is not None:
        payload["durationMs"] = duration_ms
    for key, value in extra.items():
        if value is not None:
            payload[key] = value
    print(json.dumps(payload, ensure_ascii=True, default=str))


def publish_metric(metric_name: str, value: float, unit: str = "Count"):
    try:
        cloudwatch_client.put_metric_data(
            Namespace=METRIC_NAMESPACE,
            MetricData=[
                {
                    "MetricName": metric_name,
                    "Value": value,
                    "Unit": unit,
                }
            ],
        )
    except Exception as error:
        log_event(
            service="ml.metrics",
            stage=metric_name,
            status="error",
            message=str(error),
        )
