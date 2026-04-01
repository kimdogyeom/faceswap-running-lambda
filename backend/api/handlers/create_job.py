import json
import os
import time
import uuid

import boto3
from botocore.exceptions import ClientError

from .common import bad_request, json_response, parse_body, require_fields, server_error

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


def handler(event, _context):
    try:
        payload = parse_body(event)
    except ValueError as error:
        return bad_request(str(error))

    required = require_fields(
        payload,
        "sourceImageKey",
        "targetImageKey",
        "sourceFaceIndex",
        "targetFaceIndex",
    )
    if required:
        return required

    output_format = payload.get("outputFormat", "jpeg")
    if output_format not in ("jpeg", "png"):
        return bad_request("outputFormat must be one of: jpeg, png")

    for field in ("sourceFaceIndex", "targetFaceIndex"):
        try:
            value = int(payload[field])
        except (TypeError, ValueError):
            return bad_request(f"{field} must be an integer")
        if value < 0:
            return bad_request(f"{field} must be zero or greater")
        payload[field] = value

    for field in ("sourceImageKey", "targetImageKey"):
        is_valid, error = _validate_image(payload[field])
        if not is_valid:
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
        return server_error("Failed to enqueue job")

    jobs_table.update_item(
        Key={"jobId": job_id},
        UpdateExpression="SET #status = :status, updatedAt = :updatedAt",
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={":status": "queued", ":updatedAt": int(time.time())},
    )

    return json_response(
        202,
        {
            "jobId": job_id,
            "status": "queued",
        },
    )
