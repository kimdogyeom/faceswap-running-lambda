import os
import uuid
from mimetypes import guess_extension

import boto3

from .common import bad_request, json_response, parse_body
from .observability import log_event

s3_client = boto3.client("s3")

ALLOWED_KINDS = {"source", "target"}
ALLOWED_TYPES = {"image/jpeg": ".jpg", "image/png": ".png"}
MEDIA_BUCKET_NAME = os.environ["MEDIA_BUCKET_NAME"]
UPLOADS_MAX_BYTES = int(os.environ["UPLOADS_MAX_BYTES"])


def handler(event, context):
    request_id = getattr(context, "aws_request_id", None)
    try:
        payload = parse_body(event)
    except ValueError as error:
        log_event("api.presign", "parse_body", "bad_request", request_id=request_id, message=str(error))
        return bad_request(str(error))

    kind = payload.get("kind")
    content_type = payload.get("contentType")
    try:
        content_length = int(payload.get("contentLength") or 0)
    except (TypeError, ValueError):
        return bad_request("contentLength must be an integer")

    if kind not in ALLOWED_KINDS:
        log_event("api.presign", "validate", "bad_request", request_id=request_id, message="Invalid kind")
        return bad_request("kind must be one of: source, target")

    if content_type not in ALLOWED_TYPES:
        log_event(
            "api.presign",
            "validate",
            "bad_request",
            request_id=request_id,
            message="Unsupported content type",
            contentType=content_type,
        )
        return bad_request("contentType must be image/jpeg or image/png")

    if content_length <= 0 or content_length > UPLOADS_MAX_BYTES:
        log_event(
            "api.presign",
            "validate",
            "bad_request",
            request_id=request_id,
            message="Invalid content length",
            contentLength=content_length,
        )
        return bad_request(f"contentLength must be between 1 and {UPLOADS_MAX_BYTES}")

    extension = ALLOWED_TYPES.get(content_type) or guess_extension(content_type) or ".bin"
    object_key = f"uploads/{kind}/{uuid.uuid4().hex}{extension}"

    upload_url = s3_client.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": MEDIA_BUCKET_NAME,
            "Key": object_key,
            "ContentType": content_type,
        },
        ExpiresIn=900,
    )

    log_event(
        "api.presign",
        "generate_upload_url",
        "success",
        request_id=request_id,
        objectKey=object_key,
        contentType=content_type,
        kind=kind,
    )

    return json_response(
        200,
        {
            "objectKey": object_key,
            "uploadUrl": upload_url,
            "expiresIn": 900,
        },
    )
