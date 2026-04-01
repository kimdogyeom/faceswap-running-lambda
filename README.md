# Face Swap

Serverless face swap service built around `inswapper_128.onnx`, AWS Lambda, S3 direct uploads, and a static frontend behind CloudFront.

## Architecture

- Static frontend served from S3 through CloudFront at `https://face-swap.aigyeom.com`
- API Gateway mounted behind the same CloudFront distribution under `/api/*`
- Direct browser uploads to S3 via presigned PUT URLs
- `POST /api/faces/detect` uses a container-based Lambda with InsightFace `buffalo_l`
- `POST /api/jobs` stores job state in DynamoDB and enqueues work in SQS
- Worker Lambda performs the swap and stores the result in S3
- `GET /api/jobs/{jobId}` returns status plus a presigned download URL when complete

## Repository Layout

- `bin/`, `lib/`: AWS CDK application
- `backend/api/`: lightweight Python Lambda handlers
- `backend/ml/`: container-based ML Lambda image with model download script
- `frontend/`: static site assets

## Deployment

1. Export AWS and domain settings:

```bash
export CDK_DEFAULT_ACCOUNT=123456789012
export CDK_DEFAULT_REGION=ap-northeast-2
export ROOT_DOMAIN_NAME=aigyeom.com
export SITE_SUBDOMAIN=face-swap
```

2. Install dependencies and deploy:

```bash
npm install
npm run deploy
```

The stack creates the ACM certificate in `us-east-1`, provisions CloudFront, Route53 alias records, the API, storage, queueing, and the Lambda functions.

For best parity with the included WAF configuration, deploy the stack in `us-east-1`. If you deploy elsewhere, the API still receives a regional WAF, while the optional CloudFront-scoped WAF is skipped because that resource must be managed from `us-east-1`.

## Notes

- Uploads and generated results expire after 24 hours through S3 lifecycle rules.
- Public access is limited with API Gateway throttling plus a CloudFront WAF rate-based rule.
- The ML image downloads `inswapper_128.onnx` from the specified Hugging Face commit and preloads `buffalo_l` during image build.
