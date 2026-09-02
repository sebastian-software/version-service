#!/usr/bin/env bash

set +x
set -euo pipefail

url="${1:-}"
max_attempts="${PROBE_MAX_ATTEMPTS:-16}"
retry_delay_seconds="${PROBE_RETRY_DELAY_SECONDS:-10}"

fail() {
  printf '::error::%s\n' "$1"
  exit 1
}

if [[ "$url" != https://* ]]; then
  fail "Production probe URL must use HTTPS."
fi
if [[ ! "$max_attempts" =~ ^[1-9][0-9]*$ ]]; then
  fail "PROBE_MAX_ATTEMPTS must be a positive integer."
fi
if [[ ! "$retry_delay_seconds" =~ ^[0-9]+$ ]]; then
  fail "PROBE_RETRY_DELAY_SECONDS must be a non-negative integer."
fi

response_file="$(mktemp)"
expected_file="$(mktemp)"
trap 'rm -f -- "$response_file" "$expected_file"' EXIT
printf '%s' '{"error":"invalid_request"}' > "$expected_file"

attempt=1
while ((attempt <= max_attempts)); do
  : > "$response_file"
  status=""
  curl_succeeded=false
  if status="$(curl --silent --show-error \
    --connect-timeout 5 \
    --max-time 15 \
    --output "$response_file" \
    --write-out '%{http_code}' \
    --request POST \
    --header 'content-type: application/json' \
    --data '{"unexpected":true}' \
    "$url")"; then
    curl_succeeded=true
  fi

  if [[ "$curl_succeeded" == true && "$status" == "400" ]] &&
    cmp --silent "$response_file" "$expected_file"; then
    printf 'Production probe succeeded on attempt %d of %d.\n' "$attempt" "$max_attempts"
    exit 0
  fi

  if ((attempt == max_attempts)); then
    break
  fi

  printf '::warning::Production probe attempt %d of %d did not satisfy the contract; retrying.\n' \
    "$attempt" "$max_attempts"
  sleep "$retry_delay_seconds"
  attempt=$((attempt + 1))
done

fail "Production probe did not satisfy the exact HTTP 400 response contract after $max_attempts attempts."
