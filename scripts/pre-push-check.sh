#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

npm run check

node --check frontend/app.js
node --check frontend/dashboard.js

python_files=(
  backend/api/handlers/common.py
  backend/api/handlers/public_metrics.py
  backend/api/handlers/observability.py
  backend/api/handlers/presign.py
  backend/api/handlers/create_job.py
  backend/api/handlers/get_job.py
  backend/api/handlers/metrics_dashboard.py
  backend/ml/shared/runtime.py
  backend/ml/shared/observability.py
  backend/ml/shared/public_metrics.py
  backend/ml/handlers/detect.py
  backend/ml/handlers/worker.py
  backend/ml/download_models.py
  backend/ops/discord_notifier/index.py
)

python3 -m py_compile "${python_files[@]}"

terraform -chdir=terraform/bootstrap fmt -check -recursive
terraform -chdir=terraform/bootstrap init -backend=false -input=false
terraform -chdir=terraform/bootstrap validate
