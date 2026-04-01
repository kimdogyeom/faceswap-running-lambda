import time
from typing import Dict

from botocore.exceptions import ClientError

from shared.runtime import (
    MEDIA_BUCKET_NAME,
    detect_faces,
    encode_image,
    get_jobs_table,
    get_swapper,
    load_image_from_s3,
    resize_for_processing,
    s3_client,
)


ERROR_CODES = {
    "NO_FACE_DETECTED": "NO_FACE_DETECTED",
    "INVALID_FACE_INDEX": "INVALID_FACE_INDEX",
    "IMAGE_DECODE_FAILED": "IMAGE_DECODE_FAILED",
    "MODEL_EXECUTION_FAILED": "MODEL_EXECUTION_FAILED",
    "INTERNAL_ERROR": "INTERNAL_ERROR",
}


def update_job(job_id: str, **attributes):
    names = {}
    values = {}
    expressions = []
    for index, (key, value) in enumerate(attributes.items()):
        name_key = f"#k{index}"
        value_key = f":v{index}"
        names[name_key] = key
        values[value_key] = value
        expressions.append(f"{name_key} = {value_key}")

    get_jobs_table().update_item(
        Key={"jobId": job_id},
        UpdateExpression="SET " + ", ".join(expressions),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def fail_job(job_id: str, error_code: str):
    update_job(
        job_id,
        status="failed",
        errorCode=error_code,
        updatedAt=int(time.time()),
    )


def process_job(job: Dict):
    job_id = job["jobId"]
    update_job(job_id, status="processing", updatedAt=int(time.time()))

    try:
        source_image = load_image_from_s3(job["sourceImageKey"])
        target_image = load_image_from_s3(job["targetImageKey"])
    except ValueError:
        fail_job(job_id, ERROR_CODES["IMAGE_DECODE_FAILED"])
        return
    except ClientError:
        fail_job(job_id, ERROR_CODES["IMAGE_DECODE_FAILED"])
        return

    source_processed, _ = resize_for_processing(source_image)
    target_processed, _ = resize_for_processing(target_image)

    try:
        source_faces = detect_faces(source_processed)
        target_faces = detect_faces(target_processed)
    except Exception:
        fail_job(job_id, ERROR_CODES["MODEL_EXECUTION_FAILED"])
        return

    if not source_faces or not target_faces:
        fail_job(job_id, ERROR_CODES["NO_FACE_DETECTED"])
        return

    source_index = int(job["sourceFaceIndex"])
    target_index = int(job["targetFaceIndex"])
    if source_index >= len(source_faces) or target_index >= len(target_faces):
        fail_job(job_id, ERROR_CODES["INVALID_FACE_INDEX"])
        return

    source_face = source_faces[source_index]
    target_face = target_faces[target_index]

    try:
        result_image = get_swapper().get(
            target_processed,
            target_face,
            source_face,
            paste_back=True,
        )
        result_bytes, content_type, extension = encode_image(result_image, job.get("outputFormat", "jpeg"))
    except Exception:
        fail_job(job_id, ERROR_CODES["MODEL_EXECUTION_FAILED"])
        return

    result_key = f"results/{job_id}{extension}"
    s3_client.put_object(
        Bucket=MEDIA_BUCKET_NAME,
        Key=result_key,
        Body=result_bytes,
        ContentType=content_type,
    )

    update_job(
        job_id,
        status="completed",
        resultImageKey=result_key,
        updatedAt=int(time.time()),
    )


def handler(event, _context):
    failures = []
    for record in event["Records"]:
        import json

        try:
            job = json.loads(record["body"])
            process_job(job)
        except Exception as error:
            print(f"Failed to process SQS record {record.get('messageId')}: {error}")
            failures.append({"itemIdentifier": record["messageId"]})

    return {"batchItemFailures": failures}
