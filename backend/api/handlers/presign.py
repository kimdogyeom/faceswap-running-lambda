import os
import uuid
from mimetypes import guess_extension

import boto3

from .common import bad_request, json_response, parse_body

s3_client = boto3.client("s3")

ALLOWED_KINDS = {"source", "target"}
ALLOWED_TYPES = {"image/jpeg": ".jpg", "image/png": ".png"}
MEDIA_BUCKET_NAME = os.environ["MEDIA_BUCKET_NAME"]
UPLOADS_MAX_BYTES = int(os.environ["UPLOADS_MAX_BYTES"])


def handler(event, _context):
    try:
        payload = parse_body(event)
    except ValueError as error:
        return bad_request(str(error))

    kind = payload.get("kind")
    content_type = payload.get("contentType")
    try:
        content_length = int(payload.get("contentLength") or 0)
    except (TypeError, ValueError):
        return bad_request("contentLength must be an integer")

    if kind not in ALLOWED_KINDS:
        return bad_request("kind must be one of: source, target")

    if content_type not in ALLOWED_TYPES:
        return bad_request("contentType must be image/jpeg or image/png")

    if content_length <= 0 or content_length > UPLOADS_MAX_BYTES:
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

    return json_response(
        200,
        {
            "objectKey": object_key,
            "uploadUrl": upload_url,
            "expiresIn": 900,
        },
    )
