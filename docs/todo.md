# TO BE

## 문서 보완 체크리스트

- [x] Lambda cold start, 메모리 한계 수치 근거 보강
  - 필요 이유: 현재 문서에는 Detect/Worker Lambda의 cold start 시간과 메모리 사용량 요약값만 있어, 측정 근거를 바로 확인하기 어렵다. 포트폴리오나 기술 문서에서 신뢰도를 높이려면 raw 기록을 함께 남길 필요가 있다.
  - 근거 자료:
    - benchmark 실행 로그
    - CloudWatch Logs `REPORT` 기록
    - CloudWatch Metrics raw 조회 결과 또는 캡처
  - 현재 참고 문서:
    - `README.md` 성능 섹션의 요약 수치
- 완료 기준:
    - README에 적은 cold start / warm start / max memory 수치를 뒷받침하는 원본 기록 파일 또는 캡처 경로가 추가되어 있다.
  - 구현 현황:
    - 증빙 수집 가이드 및 스크립트 추가: `scripts/collect-lambda-performance-evidence.sh`
    - 증빙 저장 경로 추가: `docs/evidence/lambda-performance/`
    - README 성능 섹션에 특정 run 근거 경로를 추가:
      - `docs/evidence/lambda-performance/runs/20260416T161826Z`
      - Detect REPORT: `docs/evidence/lambda-performance/runs/20260416T161826Z/detect/cw-report-events.txt`
      - Worker REPORT: `docs/evidence/lambda-performance/runs/20260416T161826Z/worker/cw-report-events.txt`
      - 벤치마크 로그: `docs/evidence/lambda-performance/runs/20260416T161826Z/benchmark-raw.log`
    - 실측 데이터 수집은 함수 배포/실행 환경에서 수행 완료:
      - `REGION=ap-northeast-2`
      - `DETECT_FUNCTION_NAME=FaceSwapStack-DetectFunctionEACAD5CE-nJCl45cRPT6C`
      - `WORKER_FUNCTION_NAME=FaceSwapStack-WorkerFunctionACE6A4B0-n976sSQCzRxs`
      - 테스트 이미지: `facesawp/images/test_img1.png`, `facesawp/images/test_img2.png`
