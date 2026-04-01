import base64
import json
from decimal import Decimal
from typing import Any, Dict, Optional


def _json_default(value: Any):
    if isinstance(value, Decimal):
        return int(value) if value % 1 == 0 else float(value)
    raise TypeError(f"Object of type {value.__class__.__name__} is not JSON serializable")


def json_response(status_code: int, body: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
        },
        "body": json.dumps(body, default=_json_default),
    }


def bad_request(message: str) -> Dict[str, Any]:
    return json_response(400, {"message": message})


def not_found(message: str) -> Dict[str, Any]:
    return json_response(404, {"message": message})


def server_error(message: str) -> Dict[str, Any]:
    return json_response(500, {"message": message})


def parse_body(event: Dict[str, Any]) -> Dict[str, Any]:
    raw_body = event.get("body")
    if raw_body is None:
        return {}
    if event.get("isBase64Encoded"):
        decoded = base64.b64decode(raw_body).decode("utf-8")
        try:
            return json.loads(decoded) if decoded else {}
        except json.JSONDecodeError as error:
            raise ValueError("Invalid JSON body") from error
    if isinstance(raw_body, str):
        try:
            return json.loads(raw_body) if raw_body else {}
        except json.JSONDecodeError as error:
            raise ValueError("Invalid JSON body") from error
    return raw_body


def require_fields(payload: Dict[str, Any], *fields: str) -> Optional[Dict[str, Any]]:
    missing = [field for field in fields if payload.get(field) in (None, "", [])]
    if missing:
        return bad_request(f"Missing required field(s): {', '.join(missing)}")
    return None
