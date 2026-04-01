import io
import json
import os
from typing import Any, Dict, List, Tuple

import boto3
import cv2
import insightface
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError
from insightface.app import FaceAnalysis

s3_client = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")

MEDIA_BUCKET_NAME = os.environ["MEDIA_BUCKET_NAME"]
JOBS_TABLE_NAME = os.environ["JOBS_TABLE_NAME"]
MODEL_ROOT = os.environ.get("MODEL_ROOT", "/opt/insightface")
SWAPPER_MODEL_PATH = os.environ.get("SWAPPER_MODEL_PATH", "/opt/insightface/models/inswapper_128.onnx")
FACE_DET_SIZE = int(os.environ.get("FACE_DET_SIZE", "640"))
MAX_IMAGE_SIDE = int(os.environ.get("MAX_IMAGE_SIDE", "2048"))
UPLOADS_MAX_BYTES = int(os.environ["UPLOADS_MAX_BYTES"])

_face_app = None
_swapper = None


def json_response(status_code: int, body: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def get_jobs_table():
    return dynamodb.Table(JOBS_TABLE_NAME)


def get_face_app():
    global _face_app
    if _face_app is None:
        app = FaceAnalysis(name="buffalo_l", root=MODEL_ROOT, providers=["CPUExecutionProvider"])
        app.prepare(ctx_id=-1, det_size=(FACE_DET_SIZE, FACE_DET_SIZE))
        _face_app = app
    return _face_app


def get_swapper():
    global _swapper
    if _swapper is None:
        _swapper = insightface.model_zoo.get_model(
            SWAPPER_MODEL_PATH,
            providers=["CPUExecutionProvider"],
        )
    return _swapper


def load_image_from_s3(object_key: str) -> np.ndarray:
    metadata = s3_client.head_object(Bucket=MEDIA_BUCKET_NAME, Key=object_key)
    if metadata["ContentLength"] > UPLOADS_MAX_BYTES:
        raise ValueError("IMAGE_TOO_LARGE")
    if metadata.get("ContentType") not in ("image/jpeg", "image/png"):
        raise ValueError("UNSUPPORTED_CONTENT_TYPE")

    response = s3_client.get_object(Bucket=MEDIA_BUCKET_NAME, Key=object_key)
    raw = response["Body"].read()
    try:
        image = Image.open(io.BytesIO(raw))
        image = ImageOps.exif_transpose(image).convert("RGB")
    except (UnidentifiedImageError, OSError) as error:
        raise ValueError("IMAGE_DECODE_FAILED") from error
    return cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)


def resize_for_processing(image: np.ndarray) -> Tuple[np.ndarray, float]:
    height, width = image.shape[:2]
    longest_side = max(height, width)
    if longest_side <= MAX_IMAGE_SIDE:
        return image, 1.0

    scale = MAX_IMAGE_SIDE / float(longest_side)
    resized = cv2.resize(image, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_AREA)
    return resized, scale


def detect_faces(image: np.ndarray) -> List[Any]:
    app = get_face_app()
    faces = app.get(image)
    return sorted(faces, key=lambda face: face.bbox[0])


def serialize_faces(faces: List[Any], scale: float) -> List[Dict[str, Any]]:
    serialized = []
    inverse = 1.0 / scale
    for index, face in enumerate(faces):
        bbox = [round(float(value) * inverse, 2) for value in face.bbox.tolist()]
        kps = [[round(float(x) * inverse, 2), round(float(y) * inverse, 2)] for x, y in face.kps.tolist()]
        serialized.append(
            {
                "index": index,
                "bbox": bbox,
                "kps": kps,
                "score": round(float(face.det_score), 4),
            }
        )
    return serialized


def encode_image(image: np.ndarray, output_format: str) -> Tuple[bytes, str, str]:
    if output_format == "png":
        success, encoded = cv2.imencode(".png", image)
        if not success:
            raise RuntimeError("Failed to encode PNG result")
        return encoded.tobytes(), "image/png", ".png"

    success, encoded = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
    if not success:
        raise RuntimeError("Failed to encode JPEG result")
    return encoded.tobytes(), "image/jpeg", ".jpg"
