# Face Swap Running on Lambda

[English README](./README.en.md)

`inswapper_128.onnx`를 기반으로 한 서버리스 얼굴 스왑 서비스입니다. 정적 웹은 CloudFront 뒤의 S3에서 제공하고, 추론은 AWS Lambda에서 비동기로 처리합니다.

## 이 프로젝트가 보여주는 것

- 컨테이너 기반 Lambda를 이용한 서버리스 ML 추론
- API Gateway, SQS, DynamoDB, S3를 조합한 비동기 작업 처리
- CloudWatch 대시보드와 알람을 포함한 운영 관측성
- 장기 액세스 키 없이 GitHub OIDC로 AWS에 배포하는 CI/CD

## 아키텍처

```mermaid
flowchart LR
    User[브라우저 사용자] --> CF[CloudFront]
    CF --> S3Site[S3 정적 웹]
    CF --> APIGW[API Gateway /api]
    APIGW --> Presign[Presign Lambda]
    APIGW --> Detect[Detect Lambda]
    APIGW --> CreateJob[Create Job Lambda]
    APIGW --> GetJob[Get Job Lambda]
    Presign --> Media[(S3 Media Bucket)]
    Detect --> Media
    CreateJob --> Jobs[(DynamoDB Jobs)]
    CreateJob --> Queue[SQS Job Queue]
    Queue --> Worker[Worker Lambda]
    Worker --> Media
    Worker --> Jobs
    Alarm[CloudWatch Alarms] --> SNS[SNS Alerts]
    SNS --> Discord[Optional Discord Bridge]
```

- 정적 프론트엔드는 `https://face-swap.aigyeom.com`에서 제공됩니다.
- API는 같은 CloudFront 배포 아래 `/api/*` 경로로 노출됩니다.
- 브라우저는 presigned URL을 받아 원본 이미지를 S3에 직접 업로드합니다.
- Detect Lambda는 `buffalo_l`로 얼굴을 찾고, 사용자는 얼굴 인덱스를 선택합니다.
- Worker Lambda는 `inswapper_128.onnx`를 실행해 결과 이미지를 S3에 저장합니다.
- 프론트엔드는 `GET /api/jobs/{jobId}`를 폴링해 완료 상태와 결과 URL을 가져옵니다.

## 저장소 구조

- `bin/`, `lib/`: AWS CDK 앱과 인프라 정의
- `backend/api/`: presign, job 생성, job 조회용 Python Lambda
- `backend/ml/`: ML 컨테이너 Lambda 런타임과 핸들러
- `backend/ops/`: 운영 알림용 Lambda
- `frontend/`: 정적 웹 자산

## 운영 관측성

- CloudWatch Dashboard에서 API 트래픽, 에러율, Lambda 실행 시간, 큐 상태, 커스텀 메트릭, WAF 차단 수를 확인합니다.
- CloudWatch Alarm은 API `5XX`, worker 에러, worker 실행 시간, 큐 적체, DLQ 메시지를 감시합니다.
- 알람은 SNS Topic으로 모이고, 필요하면 Discord 브리지 Lambda로 전달할 수 있습니다.
- `DISCORD_WEBHOOK_SECRET_ARN`이 없으면 Discord 관련 리소스는 생성되지 않습니다.
- API Gateway stage access log가 활성화되어 있습니다.
- 백엔드 핸들러는 `service`, `jobId`, `stage`, `status`, `durationMs`, `requestId`를 포함한 구조화 로그를 남깁니다.

## CI/CD

GitHub Actions 워크플로우는 [pipeline.yml](/home/gyeom/faceswap/.github/workflows/pipeline.yml#L1)에 있습니다.

- `pull_request`: `npm ci`, `npm run check`, `node --check frontend/app.js`, Python `py_compile`, 선택적 `cdk synth`
- `main` push: 같은 검증 후 GitHub OIDC로 AWS 인증하고 `cdk deploy`

필수 GitHub repository variables:

- `AWS_ROLE_ARN`
- `CDK_DEFAULT_ACCOUNT`
- `AWS_REGION`
- `ROOT_DOMAIN_NAME`
- `SITE_SUBDOMAIN`

선택 GitHub secret:

- `DISCORD_WEBHOOK_SECRET_ARN`

초기 설정 순서:

1. 로컬에서 한 번 배포해 GitHub deploy role과 관측성 리소스를 생성합니다.
2. CloudFormation 출력값 `GitHubDeployRoleArn`을 GitHub variable `AWS_ROLE_ARN`에 넣습니다.
3. 이후부터는 `main` push로 자동 배포할 수 있습니다.

## 로컬 배포

```bash
export CDK_DEFAULT_ACCOUNT=701111311029
export CDK_DEFAULT_REGION=ap-northeast-2
export ROOT_DOMAIN_NAME=aigyeom.com
export SITE_SUBDOMAIN=face-swap
export GITHUB_REPOSITORY_OWNER=kimdogyeom
export GITHUB_REPOSITORY_NAME=faceswap-running-lambda

npm install
npm run deploy -- FaceSwapStack --require-approval never
```

이 스택은 `us-east-1` ACM 인증서, CloudFront, Route53 alias, API Gateway, S3, SQS, DynamoDB, CloudWatch 리소스, GitHub deploy role을 함께 생성합니다.

## 성능

아래 측정값은 `ap-northeast-2`, CPU Lambda, `3008MB` 메모리, `1024x1024` JPEG 입력, `inswapper_128.onnx + buffalo_l` 기준입니다.

| 경로 | Cold Start | Warm Start | Max Memory |
| --- | ---: | ---: | ---: |
| Detect Lambda | 44.52s | 0.78s | ~1.53GB |
| Worker Lambda | 47.74s | 4.58s | ~3.00GB |

해석:

- Detect는 warm 상태에서는 빠르지만 `buffalo_l` 초기화 때문에 cold start 비용이 큽니다.
- Worker는 현재 계정/리전의 Lambda 메모리 상한 근처에서 동작합니다.
- 현재 상한이 `3008MB`라서, 그 이상 수직 확장은 다른 런타임 타깃으로 옮겨야 합니다.

## 참고

- 업로드 원본과 결과 이미지는 S3 lifecycle로 24시간 후 삭제됩니다.
- 공개 서비스 보호를 위해 API Gateway throttling과 WAF rate-based rule을 사용합니다.
- ML 이미지 빌드 시 고정된 Hugging Face 커밋에서 `inswapper_128.onnx`를 받고 `buffalo_l`를 미리 로드합니다.
