#!/usr/bin/env bash

set +x
set -euo pipefail

target=".env.bunny-deploy.local"

fail() {
  printf '::error::%s\n' "$1"
  exit 1
}

file_mode() {
  case "$(uname -s)" in
    Darwin) stat -f '%Lp' "$1" ;;
    Linux) stat -c '%a' "$1" ;;
    *) return 1 ;;
  esac
}

escape_workflow_command() {
  local value="$1"
  value="${value//%/%25}"
  value="${value//$'\r'/%0D}"
  value="${value//$'\n'/%0A}"
  printf '%s' "$value"
}

if [[ "${DECRYPTED_FILES:-}" != "$target" ]]; then
  fail "Limen must decrypt exactly the intended Bunny dotenv target."
fi
if [[ ! -f "$target" || -L "$target" ]]; then
  fail "The decrypted Bunny dotenv target must be a regular, non-symlink file."
fi
if [[ -z "${GITHUB_OUTPUT:-}" ]]; then
  fail "GITHUB_OUTPUT is not available."
fi

chmod 0600 "$target"
mode="$(file_mode "$target")" || fail "Could not inspect the decrypted Bunny dotenv mode."
if [[ "$mode" != "600" ]]; then
  fail "Could not restrict the decrypted Bunny dotenv target to mode 0600."
fi

key_count=0
deploy_key=""
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ -z "$line" || "$line" == *$'\r'* || "$line" != *=* ]]; then
    fail "The Bunny dotenv file contains an invalid line."
  fi

  name="${line%%=*}"
  value="${line#*=}"
  if [[ "$name" != "BUNNY_DEPLOY_KEY" ]]; then
    fail "The Bunny dotenv file contains an unexpected key."
  fi

  key_count=$((key_count + 1))
  if [[ "$key_count" -ne 1 || -z "$value" ]]; then
    fail "BUNNY_DEPLOY_KEY must occur exactly once and be non-empty."
  fi
  if [[ "$value" == [[:space:]]* || "$value" == *[[:space:]] ]]; then
    fail "BUNNY_DEPLOY_KEY must not have leading or trailing whitespace."
  fi

  deploy_key="$value"
done < "$target"

if [[ "$key_count" -ne 1 ]]; then
  fail "BUNNY_DEPLOY_KEY must occur exactly once and be non-empty."
fi

masked_key="$(escape_workflow_command "$deploy_key")"
printf '::add-mask::%s\n' "$masked_key"
printf 'deploy_key=%s\n' "$deploy_key" >> "$GITHUB_OUTPUT"
