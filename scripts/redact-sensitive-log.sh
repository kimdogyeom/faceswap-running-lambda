#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <input> <output>" >&2
  exit 1
fi

input_path="$1"
output_path="$2"

perl -0pe '
  s/"uploadUrl"\s*:\s*"https:\/\/[^\"]+"/"uploadUrl": "[REDACTED_PRESIGNED_URL]"/g;
  s/(X-Amz-Credential=)[^&"'"'"'\s<]+/${1}[REDACTED]/g;
  s/(X-Amz-Security-Token=)[^&"'"'"'\s<]+/${1}[REDACTED]/g;
  s/(X-Amz-Signature=)[^&"'"'"'\s<]+/${1}[REDACTED]/g;
  s/(<AWSAccessKeyId>)[^<]+(<\/AWSAccessKeyId>)/${1}[REDACTED]${2}/g;
  s/("AWSAccessKeyId"\s*:\s*")[^"]+(")/${1}[REDACTED]${2}/g;
' "$input_path" > "$output_path"
