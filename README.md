# Face Swap Running on Lambda

`inswapper_128.onnx`를 기반으로 한 서버리스 얼굴 스왑 서비스입니다. 정적 웹은 CloudFront 뒤의 S3에서 제공하고, 추론은 AWS Lambda에서 비동기로 처리합니다.

## 이 프로젝트가 보여주는 것

- 컨테이너 기반 Lambda를 이용한 서버리스 ML 추론
- API Gateway, SQS, DynamoDB, S3를 조합한 비동기 작업 처리
- CloudWatch 대시보드와 알람을 포함한 운영 관측성
- 장기 액세스 키 없이 GitHub OIDC로 AWS에 배포하는 CI/CD

## 아키텍처

![Face Swap 아키텍처 다이어그램](./images/facesawp_architecture.png)

- 정적 프론트엔드는 `https://face-swap.aigyeom.com`에서 제공됩니다.
- API는 같은 CloudFront 배포 아래 `/api/*` 경로로 노출됩니다.
- 공개 대시보드는 같은 사이트에서 `/dashboard` 경로로 제공합니다.
- 브라우저는 presigned URL을 받아 원본 이미지를 S3에 직접 업로드합니다.
- Detect Lambda는 `buffalo_l`로 얼굴을 찾고, 사용자는 얼굴 인덱스를 선택합니다.
- Worker Lambda는 `inswapper_128.onnx`를 실행해 결과 이미지를 S3에 저장합니다.
- 프론트엔드는 `GET /api/jobs/{jobId}`를 폴링해 완료 상태와 결과 URL을 가져옵니다.

## 저장소 구조

- `bin/`, `lib/`: AWS CDK 앱과 인프라 정의
- `terraform/bootstrap/`: GitHub Actions OIDC, deploy role, repository variable 부트스트랩
- `backend/api/`: presign, job 생성, job 조회용 Python Lambda
- `backend/ml/`: ML 컨테이너 Lambda 런타임과 핸들러
- `backend/ops/`: 운영 알림용 Lambda
- `frontend/`: 정적 웹 자산

## 운영 관측성

- CloudWatch Dashboard에서 API 트래픽, 에러율, Lambda 실행 시간, 큐 상태, 커스텀 메트릭을 확인합니다.
- CloudWatch Alarm은 API `5XX`, worker 에러, worker 실행 시간, 큐 적체, DLQ 메시지를 감시합니다.
- 알람은 SNS Topic으로 모이고, 필요하면 Discord 브리지 Lambda로 전달할 수 있습니다.
- `DISCORD_WEBHOOK_SECRET_ARN`이 없으면 Discord 관련 리소스는 생성되지 않습니다.
- API Gateway stage access log가 활성화되어 있습니다.
- 백엔드 핸들러는 `service`, `jobId`, `stage`, `status`, `durationMs`, `requestId`를 포함한 구조화 로그를 남깁니다.

## 공개 대시보드

- `/dashboard`는 최근 24시간 기준의 집계 메트릭만 공개합니다.
- 노출 항목은 요청 수, 완료 수, 실패 수, 성공률, 실패율, 평균 지연시간, p95 지연시간, 상태 배지, 요청/완료/실패 추이, 정규화된 실패 코드 분포입니다.
- 원본 jobId, presigned URL, 업로드 키, 파일명, raw error, AWS 리소스 이름 같은 민감 정보는 포함하지 않습니다.
- 공개 대시보드 데이터는 전용 집계 API `GET /api/metrics/dashboard`에서 제공되고, CloudFront에서 60초 캐시됩니다.
- 상세 운영 메트릭과 알람은 계속 AWS 내부 CloudWatch Dashboard에서 확인합니다.

## CI/CD

GitHub Actions 워크플로우는 [pipeline.yml](/home/gyeom/faceswap/.github/workflows/pipeline.yml#L1)에 있습니다.

- `pull_request`: `npm ci`, `npm run check`, `node --check frontend/app.js`, `node --check frontend/dashboard.js`, Python `py_compile`, `terraform fmt`, `terraform validate`, 선택적 `cdk synth`
- `main` push: 같은 검증 후 GitHub OIDC로 AWS 인증하고 `cdk deploy`

`terraform/bootstrap`는 아래 GitHub repository variables를 관리합니다.

- `AWS_ROLE_ARN`
- `CDK_DEFAULT_ACCOUNT`
- `AWS_REGION`
- `ROOT_DOMAIN_NAME`
- `SITE_SUBDOMAIN`
- `DISCORD_WEBHOOK_SECRET_ARN` (선택)

bootstrap 적용에 필요한 로컬 입력:

- `GITHUB_TOKEN`
- AWS 자격 증명
- [terraform.tfvars.example](/home/gyeom/faceswap/terraform/bootstrap/terraform.tfvars.example#L1) 기반 설정값

초기 설정 순서:

1. `cp terraform/bootstrap/terraform.tfvars.example terraform/bootstrap/terraform.tfvars`
2. `terraform/bootstrap/terraform.tfvars`를 현재 계정과 도메인 값으로 채웁니다.
3. `export GITHUB_TOKEN="$(gh auth token)"`
4. `terraform -chdir=terraform/bootstrap init`
5. `terraform -chdir=terraform/bootstrap apply`
6. 이후부터는 `main` push로 자동 배포할 수 있습니다.

## 로컬 배포

```bash
export CDK_DEFAULT_ACCOUNT=701111311029
export CDK_DEFAULT_REGION=ap-northeast-2
export ROOT_DOMAIN_NAME=aigyeom.com
export SITE_SUBDOMAIN=face-swap

npm install
npm run deploy -- FaceSwapStack --require-approval never
```

이 스택은 `us-east-1` ACM 인증서, CloudFront, Route53 alias, API Gateway, S3, SQS, DynamoDB, CloudWatch 리소스를 함께 생성합니다. GitHub Actions deploy role과 repository variable은 `terraform/bootstrap`이 관리합니다.

## 성능

아래 측정값은 `ap-northeast-2`, CPU Lambda, `3008MB` 메모리, `1024x1024` JPEG 입력, `inswapper_128.onnx + buffalo_l` 기준입니다.

| 경로 | Cold Start | Warm Start | Max Memory |
| --- | ---: | ---: | ---: |
| Detect Lambda | 95.30s *(raw max 95,304.19 ms)* | 0.78s *(raw sample 759.87~775.91 ms)* | ~1.52GB *(raw Max Memory Used 1,498~1,522 MB)* |
| Worker Lambda | 117.32s *(raw max 117,315.59 ms)* | 4.43s *(raw samples 4,314.43~4,434.76 ms)* | ~3.00GB *(raw Max Memory Used 3,002 MB)* |

### 원본 근거
- Detect / Worker Lambda의 cold start, warm start, max memory 증빙은 아래 특정 run 기준으로 재검증할 수 있습니다.
- 증빙 run: `docs/evidence/lambda-performance/runs/20260416T161826Z`
  - run 메타데이터: `docs/evidence/lambda-performance/runs/20260416T161826Z/collection-metadata.json`
  - Detect raw: `docs/evidence/lambda-performance/runs/20260416T161826Z/detect/cw-report-events.txt`
  - Worker raw: `docs/evidence/lambda-performance/runs/20260416T161826Z/worker/cw-report-events.txt`
  - 벤치마크 로그: `docs/evidence/lambda-performance/runs/20260416T161826Z/benchmark-raw.log`
  - Duration metric(요약 검증): `docs/evidence/lambda-performance/runs/20260416T161826Z/detect/cw-metric-duration.json`, `docs/evidence/lambda-performance/runs/20260416T161826Z/worker/cw-metric-duration.json`
  - InitDuration/Max Memory Used metric 조회는 이번 run에서 응답 데이터가 비어 있어 `cw-report-events.txt`의 `Max Memory Used` 값으로 근거를 확인합니다.
- 수집 실행: `scripts/collect-lambda-performance-evidence.sh` (`WINDOW_MINUTES=30`, `DETECT_FUNCTION_NAME=FaceSwapStack-DetectFunctionEACAD5CE-nJCl45cRPT6C`, `WORKER_FUNCTION_NAME=FaceSwapStack-WorkerFunctionACE6A4B0-n976sSQCzRxs`)
- 수집 가이드: `docs/evidence/lambda-performance/README.md`

해석:

- Detect는 warm 상태에서는 빠르지만 `buffalo_l` 초기화 때문에 cold start 비용이 큽니다.
- Worker는 현재 계정/리전의 Lambda 메모리 상한 근처에서 동작합니다.
- 현재 상한이 `3008MB`라서, 그 이상 수직 확장은 다른 런타임 타깃으로 옮겨야 합니다.

## 참고

- 업로드 원본과 결과 이미지는 S3 lifecycle로 24시간 후 삭제됩니다.
- 공개 서비스 보호를 위해 API Gateway throttling과 Lambda reserved concurrency 제한을 사용합니다.
- ML 이미지 빌드 시 고정된 Hugging Face 커밋에서 `inswapper_128.onnx`를 받고 `buffalo_l`를 미리 로드합니다.
