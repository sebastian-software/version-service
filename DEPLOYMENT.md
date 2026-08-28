# Deployment guide

This guide takes the edge script from this repository to a live
`https://version.sebastian-software.dev/check` endpoint. Work through it in
order; every step is independently verifiable. Client releases (for example,
Palamedes) must not embed the endpoint before the final verification step has
passed.

Production code publication is manual only. Merging or pushing to `main`,
creating a tag, or publishing a release never deploys the script. An authorized
operator starts every deployment with the GitHub **Deploy** workflow.

## Prerequisites

- Bunny.net account access with permission to create Edge Scripts and manage
  the DNS zone for `sebastian-software.dev` (domain onboarding is automated by
  `ssoft-hosting-setup`).
- The self-hosted Rybbit instance URL, a site for CLI telemetry, and an API key
  for it (Rybbit dashboard → site settings → API keys).
- Repository and organization administration access for GitHub Actions policy,
  secrets, variables, environments, and branch protection.
- Limen operator access for repository and server policy configuration.
- Limen CLI `0.10.0` for the bootstrap commands in this guide.

## 1. Create the edge script

1. Bunny dashboard → **Edge Platform** → **Scripting** → **Add Script**.
2. Type **Standalone**, name `version-service`.
3. Note the script's default hostname; it is the CNAME target for step 4.
4. In **Deployments** → **Settings**, create or copy the script-specific deploy
   key and note the script id. Do not use a Bunny account API key.

## 2. Configure the environment

Script → **Env Configuration**:

| Name              | Kind     | Value                                                  |
| ----------------- | -------- | ------------------------------------------------------ |
| `RYBBIT_ENDPOINT` | variable | Rybbit instance origin, e.g. `https://rybbit.example`  |
| `RYBBIT_SITE_ID`  | variable | numeric site id of the CLI-telemetry site              |
| `RYBBIT_API_KEY`  | secret   | API key for that site (secrets cannot be viewed later) |

The script fails closed with `503 service_unconfigured` while any of these is
missing, so a half-configured deployment never answers or counts checks.

Check the Rybbit API rate limit before real adoption: keys are limited to 500
requests per 10 minutes (~72k/day). Verify whether our installation can raise
it, and revisit sink batching or one key per project when the daily request
curve approaches that ceiling.

### Abuse and rate limiting

The endpoint is deliberately unauthenticated — any Internet client can submit
valid-looking payloads. The blast radius is bounded (checks are advisory and
fail silent, and the metric carries no identity), but sustained spam can
pollute the usage distributions and exhaust the Rybbit API quota, turning the
endpoint into `503` for honest clients. Two required mitigations:

1. Enable Bunny's platform-level per-client rate limiting (Shield/edge rules)
   on the hostname before go-live. This runs in CDN infrastructure alongside
   TLS termination; application code still never reads or stores addresses.
2. Treat the numbers as an advisory activity proxy: watch the Rybbit series
   for volume anomalies and be ready to rotate the API key or tighten the
   platform limit.

## 3. Wire GitHub deployments

The deployment trust boundary deliberately splits configuration between three
systems:

| System | Responsibility                                                                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Limen  | The SOPS-encrypted production payload containing only `BUNNY_DEPLOY_KEY`.                                                                                        |
| GitHub | Organization secret `LIMEN_INSTALL_TOKEN`; repository variables `BUNNY_SCRIPT_ID` and `BUNNY_DEPLOY_ENABLED`; protected `main` and the `production` environment. |
| Bunny  | The pre-created script, its script-specific deploy key, and the runtime Rybbit configuration from step 2.                                                        |

`LIMEN_INSTALL_TOKEN` only gives read access to the private Limen CLI release.
It is not a Limen authorization credential, a Bunny credential, or a substitute
for GitHub's private cross-repository Actions sharing.

### Current repository state

The manual workflow, Limen mapping, SOPS policy, protected-path ownership, and
rollout gate are checked in. This implementation also checks in the
SOPS-encrypted production payload at
`.limen/production/.env.bunny-deploy.local.sops.env`; its plaintext target is
absent. The organization secret `LIMEN_INSTALL_TOKEN` and the hosted
GitHub, Limen, and Bunny prerequisites remain outstanding until operators
configure and verify them. Complete those prerequisites while
`BUNNY_DEPLOY_ENABLED` is absent or not exactly `true`.

### Create the encrypted Limen payload

Use the real script-specific deploy key. Do not encrypt a placeholder such as
`REPLACE_ME`.

First, verify the CLI version:

```bash
limen --version
```

Continue only when the command reports Limen `0.10.0`. Stop and install or
update the CLI before handling the deploy key if it reports another version.

```bash
(
  set +x
  set -euo pipefail
  umask 077

  plaintext_source=".env.bunny-deploy.local"
  encrypted_source=".limen/production/.env.bunny-deploy.local.sops.env"
  bunny_deploy_key=""
  completed=false

  cleanup() {
    rm -f -- "$plaintext_source"
    unset bunny_deploy_key
    if [[ "$completed" != true ]]; then
      rm -f -- "$encrypted_source"
    fi
  }
  trap cleanup EXIT

  # Remove an older working-copy payload so a failed rotation cannot look new.
  rm -f -- "$encrypted_source"
  printf 'Bunny deploy key: ' >&2
  IFS= read -r -s bunny_deploy_key
  printf '\n' >&2
  if [[ -z "$bunny_deploy_key" ]]; then
    printf 'The Bunny deploy key must not be empty.\n' >&2
    exit 1
  fi
  printf 'BUNNY_DEPLOY_KEY=%s\n' "$bunny_deploy_key" > "$plaintext_source"

  limen encrypt --env production "$plaintext_source"
  test -s "$encrypted_source"
  limen sync
  limen sync --check
  git check-ignore --quiet "$plaintext_source"
  completed=true
)
```

The encryption command must create
`.limen/production/.env.bunny-deploy.local.sops.env`, matching the production
mapping in `.limen.yaml`. Inspect the encrypted file for its SOPS structure,
but never print or search for the plaintext value. Confirm that Git tracks only
the encrypted source and that `.env.bunny-deploy.local` remains ignored. The
block runs `limen sync` only after the mapped encrypted source exists, allowing
both initial bootstrap and later clones to converge without an update attempt
against a missing source.

### Authorize Limen and the private action

Authorize only this repository, `main`, the exact deployment workflow, and the
`production` environment:

```bash
limen policy allowed add \
  --repository sebastian-software/version-service \
  --ref refs/heads/main \
  --workflow-ref sebastian-software/version-service/.github/workflows/deploy.yml@refs/heads/main \
  --environment production
```

Verify this repository entry and the independent server-wide event and runner
policies:

```bash
limen policy allowed list
limen policy events list
limen policy runners list
```

The event policy must permit the manual deployment event, and the runner policy
must permit the GitHub-hosted runner used by the workflow. These server checks
are separate from the repository allowlist.

In the private `sebastian-software/limen` source repository, allow organization
repositories to use its actions. Also verify that the organization and this
repository's Actions policies permit the pinned
`sebastian-software/limen/actions/decrypt` action. GitHub loads that private
action with its own scoped installation token; `LIMEN_INSTALL_TOKEN` cannot fix
an Actions-sharing or Actions-policy denial.

Create organization secret `LIMEN_INSTALL_TOKEN` with read-only access to the
private Limen repository's releases and expose it only to this repository. The
workflow uses it only to download the pinned Limen CLI release.

### Protect the deployment surfaces

Create a GitHub `production` environment that accepts deployments only from
`main`. Do not add a second environment approval: manually dispatching the
workflow is the production authorization event.

Protect `main` with pull requests, at least one non-author approval, stale
approval dismissal, required code-owner review, required repository checks,
blocked force pushes and deletions, and no bypass actors. Confirm that GitHub
recognizes both `@swernerx` and `@fastner` as code owners. `.github/CODEOWNERS`
assigns those two owners to itself, the deployment workflow, the shared
freshness action, and all Limen-sensitive paths.

Set these repository variables while leaving deployment disarmed:

- `BUNNY_SCRIPT_ID` = the non-secret script id from step 1.
- `BUNNY_DEPLOY_ENABLED` = absent or any value other than the exact string
  `true`.

### Understand the manual workflow

Run the workflow from the current `main` branch. Its inputs are:

- `script_ref`: leave blank to select the immutable commit that was current
  `main` when the run started. For an intentional rollback, enter a complete
  40-character commit SHA. Uppercase or lowercase hexadecimal is accepted, but
  the commit must be an ancestor of the run's `main` anchor and contain
  `packages/edge-script/src/script.mjs`.
- `verify_only`: leave false for a deployment. Set true to exercise the
  serialized production freshness preflight without entering the `production`
  environment, requesting OIDC, running Limen, decrypting a secret, or
  publishing to Bunny.

Every run resolves the anchor and candidate once, validates the candidate with
`pnpm agent:check`, and verifies that the anchor is still current `main` before
the production job can start. `verify_preflight` and `deploy` share the
non-canceling `version-service-production` concurrency group and repeat the same
freshness check after acquiring it. Serialization is not FIFO: if `main`
advances while a run validates or waits, the stale run cannot publish. Dispatch
the workflow again from current `main`; do not retry the stale run.

For a normal run with `verify_only=false`, the production job remains skipped
unless `BUNNY_DEPLOY_ENABLED` is exactly `true`. During deployment, Limen
decrypts exactly one dotenv target. The workflow rejects unknown or duplicate
keys, changes the regular plaintext file to mode `0600`, masks the deploy key,
and passes it only to the Bunny publish action. An unconditional cleanup step
removes the plaintext file. The workflow does not upload it as an artifact or
store it in a cache.

### Roll out while disarmed

1. Merge the workflow and policy files while `BUNNY_DEPLOY_ENABLED` is absent
   or not `true`. A merge to `main` must not start a deployment.
2. Create the encrypted Limen payload, install `LIMEN_INSTALL_TOKEN`, verify
   private-action sharing and Actions policy, configure the exact Limen
   policies, and configure the GitHub environment and branch protection.
3. Set `BUNNY_SCRIPT_ID`. Confirm the Bunny runtime configuration, DNS/TLS,
   disabled request logging, and Shield/rate limiting.
4. From current `main`, manually dispatch **Deploy** with `verify_only=true`.
   Confirm that validation and both freshness checks pass, and that the run
   never enters the environment or executes OIDC, Limen, decryption, or Bunny
   steps. Use overlapping verification runs when proving the queued freshness
   behavior.
5. Immediately before the first real deployment, set
   `BUNNY_DEPLOY_ENABLED=true` and dispatch **Deploy** from current `main` with
   `verify_only=false` and blank `script_ref`.
6. Complete steps 4 and 5 below. Leave the gate enabled only after every check
   passes. If the run or a live check fails, set the variable to a value other
   than `true` before diagnosing or performing an explicit rollback.

Future changes still require a new manual dispatch; merging to `main` never
publishes them.

## 4. Attach the hostname

1. Script settings → hostnames: add `version.sebastian-software.dev`.
2. DNS: CNAME `version.sebastian-software.dev` to the script's default
   hostname (via `ssoft-hosting-setup` or manually in the Bunny DNS zone).
3. Issue or confirm the TLS certificate in the same settings screen and wait
   for `https://version.sebastian-software.dev` to serve it.

## 5. Verify the live contract

Every successful publication automatically sends an invalid request and
requires HTTP `400` with the exact body `{"error":"invalid_request"}`. This is
liveness and contract evidence, not proof that Bunny is serving the recorded
commit. A probe failure after publication leaves the new code live and marks
the workflow run failed; disarm and roll back explicitly if necessary.

The repository test for this invalid branch proves that it does not call
analytics. It does not prove that production Rybbit received no event. Complete
all of the following checks before any client release embeds the endpoint:

```bash
curl -sS -X POST https://version.sebastian-software.dev/check \
  -H "content-type: application/json" \
  -d '{"project":"palamedes","version":"1.0.0","os":"linux","arch":"x86_64","ci":false,"installedSince":"2026-08"}'
```

1. The call above returns `200` with `{"latestVersion":"…"}` matching the
   current `@palamedes/cli` version on npm.
2. An invalid payload, such as `{"unexpected":true}`, returns HTTP `400` with
   exactly `{"error":"invalid_request"}`; `GET` returns `405`.
3. The valid request produces one `update_check` event in Rybbit with the six
   aggregate properties, no client IP-derived geo data, and the fixed
   `version-service` user agent. The invalid request produces no Rybbit event.
4. Bunny request logging and observability remain off, and Rybbit shows no
   identifying fields.
5. DNS and TLS resolve correctly for the production hostname.
6. Bunny Shield or the equivalent edge rate limit is active and behaves as
   configured.

Record the candidate SHA and workflow timestamps for operational correlation,
but do not treat them as active-revision attestation.

## 6. Enable clients

Per project, after step 5:

- **Palamedes**: build the release with
  `PALAMEDES_UPDATE_ENDPOINT=https://version.sebastian-software.dev/check`.
  Any other value fails the build (see ADR-027 in the Palamedes repository).
- Future Node CLIs use the planned `@sebastian-software/update-check` package
  from this repository.

## Adding another project

1. Add the wire identifier and its npm package to `PROJECTS` in
   `packages/edge-script/src/script.mjs` (projects distributed outside npm
   need a new version-source entry — extend `latestVersion` accordingly).
2. Deploy through the manual workflow and verify the live contract with the new
   project id.
3. Wire the client in the project's own repository, including its
   `DO_NOT_TRACK` and per-tool opt-outs.

## Rollback

The rollback candidate may be any ancestor of the current `main` anchor; there
is deliberately no minimum version or allowlist. Before rollback, inspect the
candidate and select a known-good full commit SHA whose edge script still
matches the required API, privacy, and runtime assumptions.

If the rollout gate was disarmed during incident or failure response, set
`BUNNY_DEPLOY_ENABLED=true` immediately before the rollback dispatch. If the
rollback workflow or subsequent verification fails, disarm the gate again
before diagnosing the failure.

Run the current **Deploy** workflow from current `main`, set `script_ref` to the
known-good SHA, and leave `verify_only=false`. The workflow and Limen plumbing
always come from the current `main` anchor; only the selected script comes from
the historical commit. After publication, complete the entire live contract
and privacy checklist above. To restore current `main`, dispatch the workflow
again with blank `script_ref` and repeat the checklist.

## Rotate or respond to compromise

Deploy-key rotation is fail-closed and assumes that Bunny does not provide an
overlap period between old and new keys:

1. Set `BUNNY_DEPLOY_ENABLED` to a value other than `true`.
2. Rotate or retrieve the replacement script-specific deploy key according to
   Bunny's current operator procedure.
3. Recreate `.env.bunny-deploy.local` with exactly one real
   `BUNNY_DEPLOY_KEY`. Run the encryption command from the bootstrap section,
   remove the plaintext immediately, and run `limen sync --check` plus the Git
   ignore check.
4. Review and merge the encrypted-file update. Re-enable the gate only for one
   manual deployment proof, then complete the live checklist. If it fails,
   disarm the gate again before further investigation.

Treat a compromised script deploy key as a production-code compromise. Disarm
deployment and rotate the key, then use an authorized operator credential to
inspect active Bunny code and deployment history. Rotate any Bunny runtime
secret, including Rybbit credentials, that malicious replacement code could
have read or exfiltrated before re-arming deployment.
