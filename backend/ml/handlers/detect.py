from shared.runtime import (
    detect_faces,
    json_response,
    load_image_from_s3,
    resize_for_processing,
    serialize_faces,
)


def handler(event, _context):
    try:
        body = event.get("body") or "{}"
        if isinstance(body, str):
            import json

            payload = json.loads(body)
        else:
            payload = body
        image_key = payload["imageKey"]
    except Exception:
        return json_response(400, {"message": "imageKey is required"})

    try:
        image = load_image_from_s3(image_key)
        processed, scale = resize_for_processing(image)
        faces = detect_faces(processed)
    except ValueError as error:
        return json_response(400, {"message": str(error)})
    except Exception:
        return json_response(500, {"message": "Face detection failed"})

    return json_response(
        200,
        {
            "faces": serialize_faces(faces, scale),
        },
    )

