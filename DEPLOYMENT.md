# Deployment guide

This guide covers the operator-controlled path to the production hostname
`https://version-service.sebastian-software.de/check`. Work through it in order;
every step is independently verifiable, but the work is deliberately split
across three issues:

- **#9** configures production readiness, the public hostname, privacy controls,
  and aggregate monitoring. It does not publish this repository's application
  code and does not prove live analytics behavior.
- **#10** owns the first production publication and the live application,
  analytics, and privacy contract.
- **#11** must be re-planned before any client embeds or enables the endpoint.

Completing an earlier stage never authorizes a later one. In particular, keep
clients disabled until a newly approved #11 plan has passed its own evidence
gate.

Production code publication is manual only. Merging or pushing to `main`,
creating a tag, or publishing a release never deploys the script. An authorized
operator starts every deployment with the GitHub **Deploy** workflow.

## Prerequisites

- Bunny.net account access with permission to create and configure a Standalone
  Edge Script and its custom hostname.
- Access to the authoritative DNS configuration for the
  `sebastian-software.de` zone.
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

### Privacy, monitoring, and residual risk

The endpoint is deliberately unauthenticated — any Internet client can submit
valid-looking payloads. Bunny Shield/per-client rate limiting is intentionally
absent by operator decision. The previously considered 50-requests-per-10-minute
rule and its boundary proof are not part of the active production contract.

Raw Bunny request logging is currently off. Issue #9 intentionally did not
assess historical retention, forwarding, or permanent-storage state, and no
claim is made that historical records were deleted or expired. Evidence must
state only the currently observed logging configuration.

The aggregate warning is provisioned in Grafana through the merged
[Proxmox PR #116](https://git.dal12.de/fastner/proxmox/pulls/116): accepted Rybbit
`update_check` count greater than or equal to 400 over the preceding 10 minutes,
evaluated every minute, owned by `fastner`, and routed through the existing
notification policy. Redacted #9 evidence must show that the Grafana/Rybbit
datasource query succeeds, the scheduler and rule status are `ok`, the hosted
configuration has converged, and the alert uses the existing notification path.
Record only the rule, evaluation, routing, and aggregate result; never copy its
bearer credential or individual event data into this repository, an issue, a
screenshot, or an operator transcript.

Uptime Kuma dashboard 42 monitors Rybbit's non-ingesting `/api/health` endpoint.
That proves only endpoint liveness. It does not prove analytics ingestion,
Grafana alert delivery, the version-service application contract, or the health
of every Rybbit dependency.

These controls reduce detection time but do not prevent distributed abuse,
quota exhaustion, dependency failure, or misleading aggregate data. Operators
must validate the aggregate signal before acting. When containment is required,
withdraw the public custom hostname; investigate Rybbit quota or dependency
failure separately; and rotate compromised credentials without recording their
values. Before #11, keep clients disabled. After later client enablement, use
the owning client's rollback or disable control in addition to server-side
containment.

## 3. Wire GitHub deployments

The deployment trust boundary deliberately splits configuration between three
systems:

| System | Responsibility                                                                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Limen  | The SOPS-encrypted production payload containing only `BUNNY_DEPLOY_KEY`.                                                                                        |
| GitHub | Organization secret `LIMEN_INSTALL_TOKEN`; repository variables `BUNNY_SCRIPT_ID` and `BUNNY_DEPLOY_ENABLED`; protected `main` and the `production` environment. |
| Bunny  | The pre-created script, its script-specific deploy key, and the runtime Rybbit configuration from step 2.                                                        |

`LIMEN_INSTALL_TOKEN` only gives read access to the private Limen repository.
The workflow uses it to check out the pinned decrypt action and to download the
pinned Limen CLI release. It is not a Limen authorization credential or a Bunny
credential.

### Current repository state

The manual workflow, Limen mapping, SOPS policy, protected-path ownership, and
rollout gate are checked in. This implementation also checks in the
SOPS-encrypted production payload at
`.limen/production/.env.bunny-deploy.local.sops.env`; its plaintext target is
absent. The organization secret `LIMEN_INSTALL_TOKEN` and the hosted GitHub,
Limen, and Bunny prerequisites must be configured and verified by operators.
Complete those prerequisites while `BUNNY_DEPLOY_ENABLED` is absent or not
exactly `true`.

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

### Authorize Limen and bootstrap the private action

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

Create organization secret `LIMEN_INSTALL_TOKEN` with read-only access to the
private Limen repository and expose it only to this repository. Because
`version-service` is public, GitHub's native private-action sharing cannot load
the action directly: that sharing mechanism grants access only to other private
repositories. The workflow therefore uses the token to sparsely check out only
`actions/decrypt` at the reviewed Limen commit, without persisting Git
credentials, and then invokes the checked-out action locally. The same token is
passed to that action to download the pinned Limen CLI release.

Verify that the organization and this repository's Actions policies permit the
pinned `actions/checkout` action and local actions. Do not broaden either
repository's visibility to work around this bootstrap boundary.

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
   that it can read the pinned private action and CLI release, verify Actions
   policy, configure the exact Limen policies, and configure the GitHub
   environment and branch protection.
3. Set `BUNNY_SCRIPT_ID`. Confirm the Bunny runtime configuration, DNS/TLS, the
   currently disabled raw request logging setting, the intentional absence of
   Bunny Shield/per-client rate limiting, and the monitoring described above.
4. From current `main`, manually dispatch **Deploy** with `verify_only=true`.
   Confirm that validation and both freshness checks pass, and that the run
   never enters the environment or executes OIDC, Limen, decryption, or Bunny
   steps. Use overlapping verification runs when proving the queued freshness
   behavior.
5. **Issue #9 stops here.** It does not arm or execute an application
   publication. Issue #10 must not start until the repository change that
   corrects the deployment probe to the `.de` production hostname has been
   merged. It must then re-check the recorded provider state, set
   `BUNNY_DEPLOY_ENABLED=true` immediately before the first real deployment,
   and dispatch **Deploy** from current `main` with `verify_only=false` and blank
   `script_ref`.
6. Under #10, complete the live contract below. Leave the gate enabled only
   after every #10 check passes. If the run or a live check fails, set the
   variable to a value other than `true` before diagnosing or performing an
   explicit rollback. This disarms future publications; it does not remove an
   already public hostname or already published code.

Future changes still require a new manual dispatch; merging to `main` never
publishes them.

## 4. Attach the hostname

The authoritative operational path is the Bunny dashboard's **Standalone Edge
Script → custom hostname** flow plus the authoritative
`sebastian-software.de` DNS zone. Do not describe a Bunny Pull Zone or an
account-wide Bunny API mutation as authoritative for this service. Hosting
automation is not implemented; it is tracked separately in
[ssoft-hosting-setup issue #86](https://github.com/sebastian-software/ssoft-hosting-setup/issues/86).

1. Script settings → hostnames: add `version-service.sebastian-software.de`.
2. In the authoritative `sebastian-software.de` zone, create the required DNS
   record for the custom-host flow and verify the resolved target. Until issue
   #86 is implemented, this is a manual operator action.
3. Issue or confirm the TLS certificate in the same settings screen and wait
   for `https://version-service.sebastian-software.de` to serve it.
4. Record DNS, certificate coverage and expiry, HTTPS reachability, current raw
   logging-off state, intentional Shield absence, Grafana rule state, and
   Uptime Kuma dashboard/monitor state. Redact credentials, raw addresses,
   user agents, request logs, and individual analytics records.

The hostname can exist while Bunny still serves its starter. That is #9
provider evidence, not evidence that this repository's application has been
published.

## 5. Verify the live contract

This section belongs to issue #10. None of its application or analytics
assertions may be reported as #9 evidence.

Every successful publication automatically polls with an invalid request for up
to 16 attempts separated by 10 seconds. Every request has bounded connection
and total timeouts, and success requires HTTP `400` with the byte-exact body
`{"error":"invalid_request"}`. This bounded window accommodates Bunny release
propagation without weakening the contract. It is liveness and contract
evidence, not proof that Bunny is serving the recorded commit. Exhausting the
probe attempts after publication leaves the new code live and marks the
workflow run failed; disarm and roll back explicitly if necessary.

The repository test for this invalid branch proves that it does not call
analytics. It does not prove that production Rybbit received no event. Complete
all of the following checks before any client release embeds the endpoint.

### Reserve one synthetic request

Use exactly one fresh six-field tuple for each verification attempt. Mint it in
one shell and keep that shell open through the request. The timestamped
`version` makes the tuple distinguishable from real clients; the other values
are valid but explicitly synthetic:

```bash
verification_id="$(date -u +'%Y%m%d%H%M%S')"
synthetic_version="0.0.0-live.${verification_id}"
synthetic_os="verification"
synthetic_arch="synthetic_x86_64"
synthetic_installed_since="$(date -u +'%Y-%m')"
request_body="$(printf \
  '{"project":"palamedes","version":"%s","os":"%s","arch":"%s","ci":true,"installedSince":"%s"}' \
  "$synthetic_version" "$synthetic_os" "$synthetic_arch" "$synthetic_installed_since")"
printf '%s\n' "$request_body"
```

Record the printed request before continuing. Its exact stored Rybbit mapping
must be:

| Request field    | Request value                | Stored property  | Stored value                 |
| ---------------- | ---------------------------- | ---------------- | ---------------------------- |
| `project`        | `palamedes`                  | `project`        | `palamedes`                  |
| `version`        | `$synthetic_version`         | `version`        | `$synthetic_version`         |
| `os`             | `verification`               | `os`             | `verification`               |
| `arch`           | `synthetic_x86_64`           | `arch`           | `synthetic_x86_64`           |
| `ci`             | `true`                       | `mode`           | `ci`                         |
| `installedSince` | `$synthetic_installed_since` | `installedSince` | `$synthetic_installed_since` |

The request contains `ci`; the stored event contains `mode` instead. Do not
filter Rybbit for a `ci` property. Never reuse a previously sent or reserved
tuple. In particular, do not reuse the earlier `version` value
`0.0.0-verification.11.2`. A tuple is consumed when it is reserved, even if a
later guard stops the request before it is sent.

### Precompute the inclusive visibility range

Choose an expected UTC send time far enough in the future to finish the zero
baseline. Derive its five-minute visibility deadline, then convert both
boundaries to calendar dates in `Europe/Berlin`. Replace only the expected UTC
instant below; it must end in `Z`:

```bash
precompute_visibility_range() {
  expected_request_utc="REPLACE_WITH_EXPECTED_UTC_INSTANT"
  if ! expected_deadline_utc="$(node -e \
    'const value = Date.parse(process.argv[1]); if (!Number.isFinite(value)) throw new Error("invalid UTC instant"); console.log(new Date(value + 5 * 60 * 1000).toISOString().replace(".000Z", "Z"));' \
    "$expected_request_utc")"; then
    printf 'Could not derive the expected deadline.\n' >&2
    return 1
  fi

  if ! IFS=$'\t' read -r start_date end_date time_zone < <(node -e '
    const [start, end] = process.argv.slice(1).map((value) => new Date(value));
    if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) {
      throw new Error("invalid UTC boundary");
    }
    const timeZone = "Europe/Berlin";
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const day = (value) => {
      const parts = Object.fromEntries(
        formatter.formatToParts(value).map(({ type, value: part }) => [type, part]),
      );
      return `${parts.year}-${parts.month}-${parts.day}`;
    };
    console.log(`${day(start)}\t${day(end)}\t${timeZone}`);
  ' "$expected_request_utc" "$expected_deadline_utc"); then
    printf 'Could not derive the Berlin visibility range.\n' >&2
    return 1
  fi

  if [[ -z "$start_date" || -z "$end_date" || "$time_zone" != "Europe/Berlin" ]]; then
    printf 'The Berlin visibility range is incomplete.\n' >&2
    return 1
  fi

  printf 'start_date=%s\nend_date=%s\ntime_zone=%s\n' \
    "$start_date" "$end_date" "$time_zone"
}
precompute_visibility_range
```

If `precompute_visibility_range` reports an error or returns non-zero, consume
the tuple and stop before the zero baseline. Do not rerun the function with the
same tuple.

`start_date` and `end_date` are inclusive. The explicit time zone is part of
the query contract; do not derive either date in the workstation's local time
zone. As a regression check, inputs `2026-09-03T22:21:00Z` and
`2026-09-03T22:26:00Z` must both format as `2026-09-04` in `Europe/Berlin`, so
the output is `start_date=2026-09-04`, `end_date=2026-09-04`, and
`time_zone=Europe/Berlin`.

### Establish a zero baseline

Using the existing operator Rybbit query mechanism, query the precomputed range
with exact equality filters for all of the following. Do not invent a different
API path or copy credentials into the evidence:

| Query input               | Exact value                  |
| ------------------------- | ---------------------------- |
| `start_date`              | `$start_date`                |
| `end_date`                | `$end_date`                  |
| `time_zone`               | `Europe/Berlin`              |
| `event_name`              | `update_check`               |
| property `project`        | `palamedes`                  |
| property `version`        | `$synthetic_version`         |
| property `os`             | `verification`               |
| property `arch`           | `synthetic_x86_64`           |
| property `mode`           | `ci`                         |
| property `installedSince` | `$synthetic_installed_since` |

The baseline must unambiguously return zero events. Keep the date range,
timezone, event name, and all six property filters unchanged for every later
poll. A non-zero baseline, an unavailable filter, or an ambiguous count
consumes the tuple: stop without sending and restart from a newly minted tuple.

### Send once and capture the acknowledgement

Immediately before the single valid request, record the actual UTC instant,
derive its actual five-minute deadline, and convert both boundaries with the
same timezone-aware formatter. The block sends only when the actual inclusive
date range still equals the precomputed one. It captures the client HTTP status
and body separately and does not retry:

```bash
{
  actual_request_utc="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  actual_deadline_utc="$(node -e \
    'const value = Date.parse(process.argv[1]); if (!Number.isFinite(value)) throw new Error("invalid UTC instant"); console.log(new Date(value + 5 * 60 * 1000).toISOString().replace(".000Z", "Z"));' \
    "$actual_request_utc")" || actual_deadline_utc=""
  actual_start_date=""
  actual_end_date=""
  actual_time_zone=""
  range_status=0
  IFS=$'\t' read -r actual_start_date actual_end_date actual_time_zone < <(node -e '
    const [start, end] = process.argv.slice(1).map((value) => new Date(value));
    if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) {
      throw new Error("invalid UTC boundary");
    }
    const timeZone = "Europe/Berlin";
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const day = (value) => {
      const parts = Object.fromEntries(
        formatter.formatToParts(value).map(({ type, value: part }) => [type, part]),
      );
      return `${parts.year}-${parts.month}-${parts.day}`;
    };
    console.log(`${day(start)}\t${day(end)}\t${timeZone}`);
  ' "$actual_request_utc" "$actual_deadline_utc") || range_status=$?

  printf 'actual_request_utc=%s\nactual_deadline_utc=%s\n' \
    "$actual_request_utc" "$actual_deadline_utc"
  if [[ -z "$actual_deadline_utc" || "$range_status" -ne 0 || \
        "$actual_start_date" != "$start_date" || \
        "$actual_end_date" != "$end_date" || \
        "$actual_time_zone" != "$time_zone" ]]; then
    printf 'Date range changed; consume this tuple and stop without sending.\n' >&2
  else
    (
      response_body="$(mktemp)"
      trap 'rm -f -- "$response_body"' EXIT
      curl_exit=0
      http_status="$(curl --silent --show-error \
        --output "$response_body" \
        --write-out '%{http_code}' \
        --request POST \
        https://version-service.sebastian-software.de/check \
        --header 'content-type: application/json' \
        --data "$request_body")" || curl_exit=$?
      printf 'curl_exit=%s\nHTTP status=%s\nResponse body=' \
        "$curl_exit" "$http_status"
      cat "$response_body"
      printf '\n'
      rm -f -- "$response_body"
      trap - EXIT
    )
  fi
}
```

Record all four outputs separately: actual request time, actual deadline, HTTP
status, and response body. The expected client result is curl exit `0`, HTTP
`200`, and `{"latestVersion":"…"}` matching the current `@palamedes/cli`
version on npm. Any send attempt consumes the tuple, including a connection
failure or unexpected response. Do not resend it.

The outer brace group keeps `actual_request_utc` and `actual_deadline_utc` in
the open operator shell for polling. The inner subshell scopes the response
file trap; it removes the file explicitly and clears the trap after a normal
request, while an interruption still removes the exact `mktemp` path.

HTTP success proves only that version-service received Rybbit HTTP `200` with a
body of at most 1 KiB that parses as an object whose sole property is
`"success": true`, then returned the version response. Discard messages,
additional acknowledgement properties, other status codes, malformed bodies,
and oversized bodies fail closed as `analytics_unavailable`. Even the accepted
acknowledgement does not prove that the event is stored or visible in Rybbit.
Conversely, a visible event does not excuse a failed or malformed client
response. Both checks must pass.

### Poll through the actual deadline

After the request, poll with the unchanged zero-baseline query through
`actual_deadline_utc`. Keep polling even if one event appears early, and make a
final query no earlier than the deadline so a delayed duplicate is observable.
The final result must contain exactly one `update_check` event whose custom
properties are exactly the six stored values in the mapping table. The event
must have no client IP-derived geo, browser, or operating-system identity.

Zero events at the deadline is missing evidence; more than one is duplicate
ingestion. A result whose exact count or property set cannot be established is
ambiguous. A wrong event name, value, property name, client response, or
identity field is a contract mismatch. Each outcome consumes the tuple and
stops the verification; do not change the range, relax a filter, or resend.
Only exactly one matching event plus the expected client acknowledgement
passes this proof. Rybbit does not expose the raw user-agent value in its
dashboard or events API, so do not report the literal value as live Rybbit
evidence.

Then complete the remaining checks:

1. An invalid payload, such as `{"unexpected":true}`, returns HTTP `400` with
   exactly `{"error":"invalid_request"}`; `GET` returns `405`. Confirm that
   the invalid request produces no Rybbit event. If concurrent traffic makes
   that absence ambiguous, stop rather than claiming it.
2. The repository's automated edge-script test proves that the server-side
   event sent to Rybbit pins the transport identity to IP address `127.0.0.1`
   and user agent `version-service`. Treat this test together with Rybbit's
   live absence of client-derived identity as the privacy-contract evidence.
3. Raw Bunny request logging remains off, and Rybbit shows no identifying
   fields. Do not turn this current-state check into a claim about unassessed
   historical retention, forwarding, permanent storage, deletion, or expiry.
4. DNS and TLS resolve correctly for the production hostname.
5. Grafana's aggregate warning and Uptime Kuma's liveness monitor still match
   the #9 contract. Neither substitutes for the valid/invalid request evidence
   above.

Record the candidate SHA and workflow timestamps for operational correlation,
but do not treat them as active-revision attestation.

## 6. Enable clients

Issue #11 must be re-planned and approved before any project embeds or enables
the endpoint. Passing #10 does not authorize a client release. The intended
future wiring is recorded only as context for that re-planning:

- **Palamedes**: build the release with
  `PALAMEDES_UPDATE_ENDPOINT=https://version-service.sebastian-software.de/check`.
  Any other value fails the build (see ADR-027 in the Palamedes repository).
- Future Node CLIs use the planned `@sebastian-software/update-check` package
  from this repository.

Before #11 completes, keep every client-owned endpoint switch disabled. After
later enablement, incident response must use the owning client's rollback or
disable mechanism as well as any server-side hostname withdrawal.

## Adding another project

1. Add the wire identifier and its npm package to `PROJECTS` in
   `packages/edge-script/src/script.mjs` (projects distributed outside npm
   need a new version-source entry — extend `latestVersion` accordingly).
2. Deploy through the manual workflow and verify the live contract with the new
   project id.
3. Wire the client in the project's own repository, including its
   `DO_NOT_TRACK` and per-tool opt-outs.

## Rollback

Before #10 publishes the application, there is no version-service application
revision to roll back. Containment under #9 is withdrawal of the public custom
hostname while preserving redacted evidence for diagnosis. Disarming
`BUNNY_DEPLOY_ENABLED` prevents another publication but does not contain an
already public service.

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

After #11 has enabled a client, also invoke that client's owned rollback or
disable control. Do not assume that server rollback or hostname withdrawal
immediately reaches clients with cached configuration.

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
inspect active Bunny code and deployment history. If containment is required,
withdraw the public custom hostname as well; the deployment gate alone does not
remove active code. Rotate any Bunny runtime secret, including Rybbit
credentials, that malicious replacement code could have read or exfiltrated
before re-arming deployment. Never record old or replacement credential values
in commits, issues, evidence, screenshots, or transcripts.
