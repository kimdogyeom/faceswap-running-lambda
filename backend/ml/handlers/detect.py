import time

from shared.observability import log_event, publish_metric
from shared.runtime import (
    detect_faces,
    json_response,
    load_image_from_s3,
    resize_for_processing,
    serialize_faces,
)


def handler(event, context):
    request_id = getattr(context, "aws_request_id", None)
    started_at = time.perf_counter()

    try:
        body = event.get("body") or "{}"
        if isinstance(body, str):
            import json

            payload = json.loads(body)
        else:
            payload = body
        image_key = payload["imageKey"]
    except Exception:
        log_event(
            "ml.detect",
            "parse_body",
            "bad_request",
            request_id=request_id,
            duration_ms=round((time.perf_counter() - started_at) * 1000),
            message="imageKey is required",
        )
        return json_response(400, {"message": "imageKey is required"})

    try:
        image = load_image_from_s3(image_key)
        processed, scale = resize_for_processing(image)
        faces = detect_faces(processed)
    except ValueError as error:
        duration_ms = round((time.perf_counter() - started_at) * 1000)
        publish_metric("DetectDurationMs", duration_ms, unit="Milliseconds")
        log_event(
            "ml.detect",
            "detect_faces",
            "bad_request",
            request_id=request_id,
            duration_ms=duration_ms,
            message=str(error),
        )
        return json_response(400, {"message": str(error)})
    except Exception:
        duration_ms = round((time.perf_counter() - started_at) * 1000)
        publish_metric("DetectDurationMs", duration_ms, unit="Milliseconds")
        log_event(
            "ml.detect",
            "detect_faces",
            "error",
            request_id=request_id,
            duration_ms=duration_ms,
            message="Face detection failed",
        )
        return json_response(500, {"message": "Face detection failed"})

    duration_ms = round((time.perf_counter() - started_at) * 1000)
    publish_metric("DetectDurationMs", duration_ms, unit="Milliseconds")
    log_event(
        "ml.detect",
        "detect_faces",
        "success",
        request_id=request_id,
        duration_ms=duration_ms,
        imageKey=image_key,
        facesDetected=len(faces),
    )

    return json_response(
        200,
        {
            "faces": serialize_faces(faces, scale),
        },
    )
