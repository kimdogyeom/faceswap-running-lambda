# Lambda Performance Evidence

이 폴더는 Detect / Worker Lambda의 cold start, warm start, max memory 수치를 뒷받침할 raw 증빙을 저장합니다.

## 증빙 수집 가이드

`WINDOW_MINUTES`, `STACK_NAME`, `DETECT_FUNCTION_NAME`, `WORKER_FUNCTION_NAME` 환경 변수를 지정한 뒤
`scripts/collect-lambda-performance-evidence.sh`를 실행하면 아래 경로로 결과가 기록됩니다.

```bash
STACK_NAME=FaceSwapStack \
WINDOW_MINUTES=120 \
./scripts/collect-lambda-performance-evidence.sh
```

`STACK_NAME` 사용이 불가능한 경우 함수명과 로그를 직접 지정할 수 있습니다.

```bash
REGION=ap-northeast-2 \
DETECT_FUNCTION_NAME=MyDetectFunction \
WORKER_FUNCTION_NAME=MyWorkerFunction \
./scripts/collect-lambda-performance-evidence.sh
```

benchmark 실행 로그를 별도 수집한 경우 `BENCHMARK_LOG_PATH`에 전달하면 그대로 복사됩니다.

```bash
BENCHMARK_LOG_PATH=~/tmp/benchmark-output.log \
./scripts/collect-lambda-performance-evidence.sh
```

## 실행 산출물

- `runs/<run-id>/benchmark-raw.log`
- `runs/<run-id>/detect/cw-report-events.txt`
- `runs/<run-id>/detect/cw-full-logs.txt`
- `runs/<run-id>/detect/cw-metric-duration.json`
- `runs/<run-id>/detect/cw-metric-init-duration.json`
- `runs/<run-id>/detect/cw-metric-max-memory.json`
- `runs/<run-id>/worker/cw-report-events.txt`
- `runs/<run-id>/worker/cw-full-logs.txt`
- `runs/<run-id>/worker/cw-metric-duration.json`
- `runs/<run-id>/worker/cw-metric-init-duration.json`
- `runs/<run-id>/worker/cw-metric-max-memory.json`
- `runs/<run-id>/collection-metadata.json`

각 파일은 `aws` CLI raw 응답/필터 결과이므로 README 성능 요약 수치를 즉시 재검증할 수 있습니다.
