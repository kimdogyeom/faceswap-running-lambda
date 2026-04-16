# Evidence Runs

실제 증빙을 수집하면 `collect-lambda-performance-evidence.sh`가 `runs/<run-id>/` 아래에 데이터를 저장합니다.

수집 완료 후 README 성능 섹션의 링크를 아래 형태로 갱신해 원본 근거를 참조하도록 합니다.

- `runs/<run-id>/benchmark-raw.log`
- `runs/<run-id>/detect/cw-report-events.txt`
- `runs/<run-id>/detect/cw-metric-duration.json`
- `runs/<run-id>/detect/cw-metric-init-duration.json`
- `runs/<run-id>/detect/cw-metric-max-memory.json`
- `runs/<run-id>/worker/cw-report-events.txt`
- `runs/<run-id>/worker/cw-metric-duration.json`
- `runs/<run-id>/worker/cw-metric-init-duration.json`
- `runs/<run-id>/worker/cw-metric-max-memory.json`
- `runs/<run-id>/collection-metadata.json`

현재는 수집을 위한 AWS 함수명이 미해결 상태라 placeholder 상태로 유지됩니다.
