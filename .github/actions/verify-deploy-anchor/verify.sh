#!/usr/bin/env bash

set -euo pipefail

eligible=false
current=""

write_outputs() {
  {
    echo "eligible=$eligible"
    if [[ -n "$current" ]]; then
      echo "current=$current"
    fi
  } >> "$GITHUB_OUTPUT"
}
trap write_outputs EXIT

if [[ ! "${EXPECTED_ANCHOR:-}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::The deployment anchor must be a lowercase full commit SHA."
  exit 1
fi

if ! git fetch --force --no-tags origin \
  '+refs/heads/main:refs/remotes/origin/main'; then
  echo "::error::Could not fetch current main for the deployment freshness check."
  exit 1
fi

if ! current="$(git rev-parse --verify 'refs/remotes/origin/main^{commit}')"; then
  echo "::error::Could not resolve current main for the deployment freshness check."
  exit 1
fi

if [[ ! "$current" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::Current main did not resolve to a full commit SHA."
  exit 1
fi

if [[ "$current" != "$EXPECTED_ANCHOR" ]]; then
  echo "::error::The deployment anchor is stale; dispatch again from current main."
  exit 1
fi

eligible=true
echo "Deployment anchor is still current main."
