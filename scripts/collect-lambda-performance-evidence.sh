#!/usr/bin/env bash
set -euo pipefail

REGION="${REGION:-ap-northeast-2}"
WINDOW_MINUTES="${WINDOW_MINUTES:-120}"
PERIOD="${PERIOD:-300}"
LIMIT="${LIMIT:-200}"
STACK_NAME="${STACK_NAME:-}"
DETECT_FUNCTION_NAME="${DETECT_FUNCTION_NAME:-}"
WORKER_FUNCTION_NAME="${WORKER_FUNCTION_NAME:-}"
BENCHMARK_LOG_PATH="${BENCHMARK_LOG_PATH:-}"
OUT_DIR="${OUT_DIR:-docs/evidence/lambda-performance/runs}"
REDACT_SCRIPT="${REDACT_SCRIPT:-scripts/redact-sensitive-log.sh}"

if [[ ! -x "$REDACT_SCRIPT" ]]; then
  echo "redaction script is missing or not executable: $REDACT_SCRIPT"
  exit 1
fi

if [[ -z "${DETECT_FUNCTION_NAME}" && -n "${STACK_NAME}" ]]; then
  DETECT_FUNCTION_NAME="$(aws cloudformation describe-stack-resources \
    --region "$REGION" \
    --stack-name "$STACK_NAME" \
    --query "StackResources[?LogicalResourceId=='DetectFunction'].PhysicalResourceId | [0]" \
    --output text)"
fi

if [[ -z "${WORKER_FUNCTION_NAME}" && -n "${STACK_NAME}" ]]; then
  WORKER_FUNCTION_NAME="$(aws cloudformation describe-stack-resources \
    --region "$REGION" \
    --stack-name "$STACK_NAME" \
    --query "StackResources[?LogicalResourceId=='WorkerFunction'].PhysicalResourceId | [0]" \
    --output text)"
fi

if [[ -z "${DETECT_FUNCTION_NAME}" || "${DETECT_FUNCTION_NAME}" == "None" ]]; then
  echo "DETECT_FUNCTION_NAME is missing."
  echo "Set STACK_NAME with DetectFunction resource or pass -e DETECT_FUNCTION_NAME."
  exit 1
fi

if [[ -z "${WORKER_FUNCTION_NAME}" || "${WORKER_FUNCTION_NAME}" == "None" ]]; then
  echo "WORKER_FUNCTION_NAME is missing."
  echo "Set STACK_NAME with WorkerFunction resource or pass -e WORKER_FUNCTION_NAME."
  exit 1
fi

END_EPOCH="$(date -u +%s)"
START_EPOCH="$((END_EPOCH - WINDOW_MINUTES * 60))"
START_TIME="$(date -u -d "@${START_EPOCH}" +%Y-%m-%dT%H:%M:%SZ)"
END_TIME="$(date -u -d "@${END_EPOCH}" +%Y-%m-%dT%H:%M:%SZ)"
START_MS="$((START_EPOCH * 1000))"
END_MS="$((END_EPOCH * 1000))"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"

RUN_DIR="${OUT_DIR}/${RUN_ID}"
mkdir -p "${RUN_DIR}/detect" "${RUN_DIR}/worker"

collect_report_events() {
  local function_name="$1"
  local output="$2"
  aws logs filter-log-events \
    --region "$REGION" \
    --log-group-name "/aws/lambda/${function_name}" \
    --start-time "$START_MS" \
    --end-time "$END_MS" \
    --filter-pattern "REPORT" \
    --limit "$LIMIT" \
    --output json > "$output"
}

collect_full_logs() {
  local function_name="$1"
  local output="$2"
  aws logs filter-log-events \
    --region "$REGION" \
    --log-group-name "/aws/lambda/${function_name}" \
    --start-time "$START_MS" \
    --end-time "$END_MS" \
    --limit "$LIMIT" \
    --output json > "$output"
}

collect_metric() {
  local function_name="$1"
  local metric_name="$2"
  local output="$3"
  aws cloudwatch get-metric-statistics \
    --region "$REGION" \
    --namespace AWS/Lambda \
    --metric-name "$metric_name" \
    --dimensions Name=FunctionName,Value="${function_name}" \
    --statistics Maximum Average \
    --start-time "$START_TIME" \
    --end-time "$END_TIME" \
    --period "$PERIOD" \
    --output json > "$output"
}

sanitize_log_copy() {
  local input_path="$1"
  local output_path="$2"
  "$REDACT_SCRIPT" "$input_path" "$output_path"
}

if [[ -n "$BENCHMARK_LOG_PATH" ]]; then
  if [[ ! -f "$BENCHMARK_LOG_PATH" ]]; then
    echo "BENCHMARK_LOG_PATH provided but not found: $BENCHMARK_LOG_PATH"
    exit 1
  fi
  sanitize_log_copy "$BENCHMARK_LOG_PATH" "${RUN_DIR}/benchmark-raw.log"
else
  cat > "${RUN_DIR}/benchmark-raw.log" <<'INNER'
benchmark log not included in this run.
Set BENCHMARK_LOG_PATH=<path_to_raw_benchmark_log> to copy benchmark output.
Sensitive values should be redacted before any evidence log is committed.
INNER
fi

collect_report_events "$DETECT_FUNCTION_NAME" "${RUN_DIR}/detect/cw-report-events.txt"
collect_report_events "$WORKER_FUNCTION_NAME" "${RUN_DIR}/worker/cw-report-events.txt"
collect_full_logs "$DETECT_FUNCTION_NAME" "${RUN_DIR}/detect/cw-full-logs.txt"
collect_full_logs "$WORKER_FUNCTION_NAME" "${RUN_DIR}/worker/cw-full-logs.txt"
collect_metric "$DETECT_FUNCTION_NAME" "InitDuration" "${RUN_DIR}/detect/cw-metric-init-duration.json"
collect_metric "$DETECT_FUNCTION_NAME" "Duration" "${RUN_DIR}/detect/cw-metric-duration.json"
collect_metric "$DETECT_FUNCTION_NAME" "Max Memory Used" "${RUN_DIR}/detect/cw-metric-max-memory.json"
collect_metric "$WORKER_FUNCTION_NAME" "InitDuration" "${RUN_DIR}/worker/cw-metric-init-duration.json"
collect_metric "$WORKER_FUNCTION_NAME" "Duration" "${RUN_DIR}/worker/cw-metric-duration.json"
collect_metric "$WORKER_FUNCTION_NAME" "Max Memory Used" "${RUN_DIR}/worker/cw-metric-max-memory.json"

cat > "${RUN_DIR}/collection-metadata.json" <<INNER
{
  "runId": "${RUN_ID}",
  "region": "${REGION}",
  "windowMinutes": ${WINDOW_MINUTES},
  "startTime": "${START_TIME}",
  "endTime": "${END_TIME}",
  "stackName": "${STACK_NAME}",
  "detectFunctionName": "${DETECT_FUNCTION_NAME}",
  "workerFunctionName": "${WORKER_FUNCTION_NAME}",
  "periodSeconds": ${PERIOD},
  "limit": ${LIMIT}
}
INNER

echo "Saved evidence bundle to: ${RUN_DIR}"
