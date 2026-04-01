import time
from typing import Dict

from botocore.exceptions import ClientError

from shared.observability import log_event, publish_metric
from shared.public_metrics import increment_public_metrics
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


def compute_total_duration_ms(job: Dict, fallback_duration_ms: int) -> int:
    created_at = job.get("createdAt")
    if created_at is None:
        return fallback_duration_ms
    return max(int(time.time()) - int(created_at), 0) * 1000


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


def fail_job(
    job: Dict,
    job_id: str,
    error_code: str,
    request_id: str | None = None,
    stage: str = "process_job",
    duration_ms: int | None = None,
    **extra,
):
    update_job(
        job_id,
        status="failed",
        errorCode=error_code,
        updatedAt=int(time.time()),
    )
    publish_metric("JobsFailed", 1)
    if duration_ms is not None:
        publish_metric("JobTotalDurationMs", duration_ms, unit="Milliseconds")
    try:
        increment_public_metrics(failed_delta=1, failure_code=error_code)
    except Exception as error:
        log_event(
            "ml.worker",
            "record_public_metrics",
            "error",
            request_id=request_id,
            job_id=job_id,
            duration_ms=duration_ms,
            message=str(error),
        )
    log_event(
        "ml.worker",
        stage,
        "failed",
        request_id=request_id,
        job_id=job_id,
        duration_ms=duration_ms,
        errorCode=error_code,
        **extra,
    )


def process_job(job: Dict, request_id: str | None = None):
    job_id = job["jobId"]
    started_at = time.perf_counter()
    update_job(job_id, status="processing", updatedAt=int(time.time()))
    log_event("ml.worker", "process_job", "started", request_id=request_id, job_id=job_id)

    try:
        source_image = load_image_from_s3(job["sourceImageKey"])
        target_image = load_image_from_s3(job["targetImageKey"])
    except ValueError:
        total_duration_ms = compute_total_duration_ms(
            job,
            round((time.perf_counter() - started_at) * 1000),
        )
        fail_job(
            job,
            job_id,
            ERROR_CODES["IMAGE_DECODE_FAILED"],
            request_id=request_id,
            stage="load_images",
            duration_ms=total_duration_ms,
        )
        return
    except ClientError:
        total_duration_ms = compute_total_duration_ms(
            job,
            round((time.perf_counter() - started_at) * 1000),
        )
        fail_job(
            job,
            job_id,
            ERROR_CODES["IMAGE_DECODE_FAILED"],
            request_id=request_id,
            stage="load_images",
            duration_ms=total_duration_ms,
        )
        return

    source_processed, _ = resize_for_processing(source_image)
    target_processed, _ = resize_for_processing(target_image)

    detect_started_at = time.perf_counter()
    try:
        source_faces = detect_faces(source_processed)
        target_faces = detect_faces(target_processed)
    except Exception:
        total_duration_ms = compute_total_duration_ms(
            job,
            round((time.perf_counter() - started_at) * 1000),
        )
        fail_job(
            job,
            job_id,
            ERROR_CODES["MODEL_EXECUTION_FAILED"],
            request_id=request_id,
            stage="detect_faces",
            duration_ms=total_duration_ms,
        )
        return
    detect_duration_ms = round((time.perf_counter() - detect_started_at) * 1000)

    if not source_faces or not target_faces:
        total_duration_ms = compute_total_duration_ms(
            job,
            round((time.perf_counter() - started_at) * 1000),
        )
        fail_job(
            job,
            job_id,
            ERROR_CODES["NO_FACE_DETECTED"],
            request_id=request_id,
            stage="detect_faces",
            duration_ms=total_duration_ms,
            facesDetectedSource=len(source_faces),
            facesDetectedTarget=len(target_faces),
        )
        return

    source_index = int(job["sourceFaceIndex"])
    target_index = int(job["targetFaceIndex"])
    if source_index >= len(source_faces) or target_index >= len(target_faces):
        total_duration_ms = compute_total_duration_ms(
            job,
            round((time.perf_counter() - started_at) * 1000),
        )
        fail_job(
            job,
            job_id,
            ERROR_CODES["INVALID_FACE_INDEX"],
            request_id=request_id,
            stage="validate_faces",
            duration_ms=total_duration_ms,
            sourceFaceIndex=source_index,
            targetFaceIndex=target_index,
        )
        return

    source_face = source_faces[source_index]
    target_face = target_faces[target_index]

    swap_started_at = time.perf_counter()
    try:
        result_image = get_swapper().get(
            target_processed,
            target_face,
            source_face,
            paste_back=True,
        )
        result_bytes, content_type, extension = encode_image(result_image, job.get("outputFormat", "jpeg"))
    except Exception:
        total_duration_ms = compute_total_duration_ms(
            job,
            round((time.perf_counter() - started_at) * 1000),
        )
        fail_job(
            job,
            job_id,
            ERROR_CODES["MODEL_EXECUTION_FAILED"],
            request_id=request_id,
            stage="swap_faces",
            duration_ms=total_duration_ms,
        )
        return
    swap_duration_ms = round((time.perf_counter() - swap_started_at) * 1000)

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
    total_duration_ms = compute_total_duration_ms(
        job,
        round((time.perf_counter() - started_at) * 1000),
    )
    publish_metric("JobsCompleted", 1)
    publish_metric("SwapDurationMs", swap_duration_ms, unit="Milliseconds")
    publish_metric("JobTotalDurationMs", total_duration_ms, unit="Milliseconds")
    try:
        increment_public_metrics(completed_delta=1)
    except Exception as error:
        log_event(
            "ml.worker",
            "record_public_metrics",
            "error",
            request_id=request_id,
            job_id=job_id,
            duration_ms=total_duration_ms,
            message=str(error),
        )
    log_event(
        "ml.worker",
        "process_job",
        "completed",
        request_id=request_id,
        job_id=job_id,
        duration_ms=total_duration_ms,
        detectDurationMs=detect_duration_ms,
        swapDurationMs=swap_duration_ms,
        resultImageKey=result_key,
    )


def handler(event, context):
    request_id = getattr(context, "aws_request_id", None)
    failures = []
    for record in event["Records"]:
        import json

        try:
            job = json.loads(record["body"])
            process_job(job, request_id=request_id)
        except Exception as error:
            log_event(
                "ml.worker",
                "parse_record",
                "error",
                request_id=request_id,
                job_id=record.get("messageId"),
                message=str(error),
            )
            failures.append({"itemIdentifier": record["messageId"]})

    return {"batchItemFailures": failures}
