import os
import time

import boto3

from .common import json_response, not_found

dynamodb = boto3.resource("dynamodb")
s3_client = boto3.client("s3")

MEDIA_BUCKET_NAME = os.environ["MEDIA_BUCKET_NAME"]
JOBS_TABLE_NAME = os.environ["JOBS_TABLE_NAME"]
DOWNLOAD_URL_EXPIRES_SECONDS = int(os.environ["DOWNLOAD_URL_EXPIRES_SECONDS"])

jobs_table = dynamodb.Table(JOBS_TABLE_NAME)


def handler(event, _context):
    job_id = (event.get("pathParameters") or {}).get("jobId")
    if not job_id:
        return not_found("jobId path parameter is required")

    response = jobs_table.get_item(Key={"jobId": job_id})
    item = response.get("Item")
    if not item:
        return not_found("Job not found")

    now = int(time.time())
    payload = {
        "jobId": job_id,
        "status": "expired" if item.get("ttl") and item["ttl"] < now else item["status"],
        "errorCode": item.get("errorCode"),
        "expiresAt": item.get("ttl"),
    }

    if item.get("resultImageKey") and payload["status"] == "completed":
        payload["resultImageKey"] = item["resultImageKey"]
        payload["downloadUrl"] = s3_client.generate_presigned_url(
            "get_object",
            Params={"Bucket": MEDIA_BUCKET_NAME, "Key": item["resultImageKey"]},
            ExpiresIn=DOWNLOAD_URL_EXPIRES_SECONDS,
        )
        payload["downloadUrlExpiresAt"] = now + DOWNLOAD_URL_EXPIRES_SECONDS

    return json_response(200, payload)
