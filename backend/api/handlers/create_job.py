import json
import os
import time
import uuid

import boto3
from botocore.exceptions import ClientError

from .common import bad_request, json_response, parse_body, require_fields, server_error
from .observability import log_event, publish_metric

dynamodb = boto3.resource("dynamodb")
sqs_client = boto3.client("sqs")
s3_client = boto3.client("s3")

MEDIA_BUCKET_NAME = os.environ["MEDIA_BUCKET_NAME"]
JOBS_TABLE_NAME = os.environ["JOBS_TABLE_NAME"]
JOB_QUEUE_URL = os.environ["JOB_QUEUE_URL"]
UPLOADS_MAX_BYTES = int(os.environ["UPLOADS_MAX_BYTES"])

jobs_table = dynamodb.Table(JOBS_TABLE_NAME)


def _validate_image(object_key: str):
    if not object_key.startswith("uploads/"):
        return False, "Image object must be under uploads/"
    try:
        metadata = s3_client.head_object(Bucket=MEDIA_BUCKET_NAME, Key=object_key)
    except ClientError as error:
        error_code = error.response.get("Error", {}).get("Code")
        if error_code in ("404", "NoSuchKey", "NotFound"):
            return False, "Image object not found"
        return False, "Failed to read image metadata"

    if metadata["ContentLength"] > UPLOADS_MAX_BYTES:
        return False, "Image object exceeds the size limit"

    if metadata.get("ContentType") not in ("image/jpeg", "image/png"):
        return False, "Image content type must be image/jpeg or image/png"

    return True, None


def handler(event, context):
    request_id = getattr(context, "aws_request_id", None)
    started_at = time.perf_counter()

    try:
        payload = parse_body(event)
    except ValueError as error:
        log_event(
            "api.create_job",
            "parse_body",
            "bad_request",
            request_id=request_id,
            duration_ms=round((time.perf_counter() - started_at) * 1000),
            message=str(error),
        )
        return bad_request(str(error))

    required = require_fields(
        payload,
        "sourceImageKey",
        "targetImageKey",
        "sourceFaceIndex",
        "targetFaceIndex",
    )
    if required:
        log_event(
            "api.create_job",
            "validate",
            "bad_request",
            request_id=request_id,
            duration_ms=round((time.perf_counter() - started_at) * 1000),
            message="Missing required fields",
        )
        return required

    output_format = payload.get("outputFormat", "jpeg")
    if output_format not in ("jpeg", "png"):
        log_event(
            "api.create_job",
            "validate",
            "bad_request",
            request_id=request_id,
            duration_ms=round((time.perf_counter() - started_at) * 1000),
            message="Invalid output format",
            outputFormat=output_format,
        )
        return bad_request("outputFormat must be one of: jpeg, png")

    for field in ("sourceFaceIndex", "targetFaceIndex"):
        try:
            value = int(payload[field])
        except (TypeError, ValueError):
            log_event(
                "api.create_job",
                "validate",
                "bad_request",
                request_id=request_id,
                duration_ms=round((time.perf_counter() - started_at) * 1000),
                message=f"{field} must be an integer",
            )
            return bad_request(f"{field} must be an integer")
        if value < 0:
            log_event(
                "api.create_job",
                "validate",
                "bad_request",
                request_id=request_id,
                duration_ms=round((time.perf_counter() - started_at) * 1000),
                message=f"{field} must be zero or greater",
            )
            return bad_request(f"{field} must be zero or greater")
        payload[field] = value

    for field in ("sourceImageKey", "targetImageKey"):
        is_valid, error = _validate_image(payload[field])
        if not is_valid:
            log_event(
                "api.create_job",
                "validate",
                "bad_request",
                request_id=request_id,
                duration_ms=round((time.perf_counter() - started_at) * 1000),
                message=error,
                invalidField=field,
            )
            return bad_request(f"{field}: {error}")

    job_id = uuid.uuid4().hex
    now = int(time.time())
    ttl = now + (24 * 60 * 60)

    item = {
        "jobId": job_id,
        "status": "pending",
        "createdAt": now,
        "updatedAt": now,
        "ttl": ttl,
        "sourceImageKey": payload["sourceImageKey"],
        "targetImageKey": payload["targetImageKey"],
        "sourceFaceIndex": payload["sourceFaceIndex"],
        "targetFaceIndex": payload["targetFaceIndex"],
        "outputFormat": output_format,
    }

    jobs_table.put_item(Item=item)
    try:
        sqs_client.send_message(
            QueueUrl=JOB_QUEUE_URL,
            MessageBody=json.dumps(item),
        )
    except Exception:
        jobs_table.delete_item(Key={"jobId": job_id})
        log_event(
            "api.create_job",
            "enqueue",
            "error",
            request_id=request_id,
            job_id=job_id,
            duration_ms=round((time.perf_counter() - started_at) * 1000),
            message="Failed to enqueue job",
        )
        return server_error("Failed to enqueue job")

    jobs_table.update_item(
        Key={"jobId": job_id},
        UpdateExpression="SET #status = :status, updatedAt = :updatedAt",
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={":status": "queued", ":updatedAt": int(time.time())},
    )

    duration_ms = round((time.perf_counter() - started_at) * 1000)
    publish_metric("JobsCreated", 1)
    log_event(
        "api.create_job",
        "enqueue",
        "success",
        request_id=request_id,
        job_id=job_id,
        duration_ms=duration_ms,
        outputFormat=output_format,
    )

    return json_response(
        202,
        {
            "jobId": job_id,
            "status": "queued",
        },
    )
