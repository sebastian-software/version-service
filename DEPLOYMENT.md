# Deployment guide

This guide covers the operator-controlled path to the production hostname
`https://version-service.sebastian-software.de/check`. Work through it in order;
every step is independently verifiable. The initial rollout was deliberately
split across three issues:

- **#9** configures production readiness, the public hostname, privacy controls,
  and aggregate monitoring. It does not publish this repository's application
  code and does not prove live analytics behavior.
- **#10** owns the first production publication and the live application,
  analytics, and privacy contract.
- **#11** verified the deployed service for client adoption with a fresh
  production tuple and the supported Rybbit/native-Curl procedure below.

The application is deployed, and its #11 production contract verification is
complete. The deployment candidate associated with that successful verification
was `04b56723d03c28e9b94a4db9fbbc57a2ee1a3940`; this association is operational
correlation, not attestation of the active Bunny revision. Client integration,
release, and rollback remain owned by each client repository; this deployment
guide does not authorize a client release.

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
values. For an enabled client, use the owning client's rollback or disable
control in addition to server-side containment.

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
Limen, and Bunny prerequisites are configured for the current production
deployment. Operators must reverify them before a future publication.
Configure a new environment or repair drift only while
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
approval dismissal, required repository checks, and blocked force pushes and
deletions. Configured pull-request bypass remains allowed, and an
`@swernerx` review is not required. Keep the protected deployment and Limen
paths covered by the repository's current ownership policy.

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
5. For a production publication, re-check the recorded provider state, set
   `BUNNY_DEPLOY_ENABLED=true` immediately before the run, and dispatch
   **Deploy** from current `main` with `verify_only=false`. Leave `script_ref`
   blank for current `main`, or supply a reviewed full SHA for an intentional
   rollback.
6. Complete the live contract below after publication. Leave the gate enabled
   only after every check passes. If the run or a live check fails, set the
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

During initial setup, the hostname could exist while Bunny still served its
starter. Hostname evidence alone therefore never proves that this repository's
application was published.

## 5. Verify the live contract

Every successful publication automatically polls with an invalid request for up
to 16 attempts separated by 10 seconds. Each request uses a five-second
connection timeout and a 15-second total timeout, and success requires HTTP
`400` with byte-exact body `{"error":"invalid_request"}`. This accommodates
Bunny release propagation without weakening the contract. It proves liveness
and the invalid-request contract, not the deployed revision or Rybbit
visibility. If all attempts fail, the published code remains live while the
workflow fails; disarm and roll back explicitly when necessary.

The successful production verification for issue #11 was associated with
deployment candidate `04b56723d03c28e9b94a4db9fbbc57a2ee1a3940`. The check
did not attest which revision was active in Bunny. Its terminal result was
`COMPLETE` with `success=true` and `cleanupComplete=true`:

- The fresh browser fixtures passed 32/32 tests, the fresh Curl fixtures passed
  37/37 tests, and the independent review reported zero Critical, Important,
  and Note findings. That evidence applies only to this completed attempt.
- The valid POST returned HTTP `200` with an exact one-key `latestVersion`
  response that matched the current stable npm version. After its own complete,
  fixed five-minute visibility window, Rybbit contained exactly one matching
  aggregate and exactly one matching event.
- The invalid POST returned HTTP `400` with the byte-exact body
  `{"error":"invalid_request"}`. Its separate complete five-minute visibility
  window added no event.
- The GET returned HTTP `405` with the byte-exact body
  `{"error":"method_not_allowed"}` and exactly `Allow: POST`. It added no
  event.
- The stored event had exactly the six business properties `arch`,
  `installedSince`, `mode`, `os`, `project`, and `version`. It had no geography,
  browser, derived operating system, language, device, or identified-user data.
  Opaque provider session and user identifiers were recorded only as presence
  booleans, never as values.
- Repository tests separately proved that the Rybbit transport substitutes the
  neutral IP address `127.0.0.1` and user agent `version-service`, and that the
  invalid POST and GET branches do not call Rybbit. The live no-added-event
  observations complement those branch tests; neither source replaces the
  other.

The production check also reconfirmed the `.de` hostname's DNS and TLS path.
Bunny raw request logging was observed off at verification time. This is a
current-configuration statement only; it makes no claim about historical
retention, forwarding, deletion, or expiry. Bunny Shield and per-client rate
limiting remain intentionally absent. Distributed abuse, quota exhaustion,
dependency failure, and misleading aggregate data therefore remain accepted
risks.

Grafana's Rybbit-backed `update_check >= 400` rule for the preceding 10 minutes
was verified with one-minute evaluation, `ok` status, converged hosted
configuration, and the existing notification route selected. Uptime Kuma
dashboard 42 was verified against Rybbit's non-ingesting `/api/health`
endpoint. Grafana detects an aggregate condition but does not prevent abuse or
prove an individual event; Kuma proves endpoint liveness but not ingestion,
quota, alert delivery, the application contract, or every Rybbit dependency.

### Repeat the verification

Treat every repeat as a new verification, not as a replay of #11. Create fresh,
timestamped ephemeral browser, Curl-wrapper, and fixture files:

- `/private/tmp/version-service-issue11-browser-<run>.js`
- `/private/tmp/version-service-issue11-browser-<run>.test.mjs`
- `/private/tmp/version-service-issue11-curl-<run>.mjs`
- `/private/tmp/version-service-issue11-curl-<run>.test.mjs`

The helpers are never tracked or reused. Start from a fresh, approved
live-verification plan and run `effective-flow apply <plan-or-issue>`; Effective
Flow routes the application to its build workflow and generates fresh ephemeral
helpers for that attempt. This section defines their required contract. It does
not authorize an operator to hand-author a helper or reuse a previous helper or
audit. Run all local fixture checks before reserving a tuple:

```bash
node --check /private/tmp/version-service-issue11-browser-<run>.js
node --check /private/tmp/version-service-issue11-browser-<run>.test.mjs
node --check /private/tmp/version-service-issue11-curl-<run>.mjs
node --check /private/tmp/version-service-issue11-curl-<run>.test.mjs
node --test /private/tmp/version-service-issue11-browser-<run>.test.mjs
node --test /private/tmp/version-service-issue11-curl-<run>.test.mjs
```

Commission a fresh independent adversarial review of both helpers. Continue
only with zero Critical and zero Important findings. A previous run's tests or
review cannot support a new live attempt.

Before tuple reservation, confirm all of the following:

1. The repository checkout and deployed candidate are the intended revisions,
   `BUNNY_DEPLOY_ENABLED` is absent, and no deployment-capable workflow is
   queued or active.
2. The production hostname still has valid DNS and TLS, and the current Bunny
   logging, intentional Shield absence, Grafana rule, and Kuma monitor match
   the state described above. Do not mutate a provider during verification.
3. The browser is authenticated to the clean target Rybbit API playground, and
   a fresh private Terminal shell has history and tracing disabled.
4. The local native Curl binary is exactly version `8.7.1`.

### Keep browser and Terminal responsibilities separate

The browser helper owns only tuple and phase state, the same-origin Rybbit
reducer, and bounded visibility observations. During one page-local
initialization, it derives the real opaque site identifier from the
authenticated playground route, validates it, and freezes it with the expected
origin and two Rybbit query URLs. It exposes no identifier, raw row, generic
network primitive, or production/npm access.

The two Rybbit requests are fixed same-origin GETs with no body or
caller-controlled options. They use `credentials="same-origin"`,
`cache="no-store"`, `redirect="error"`, and a bounded abort signal. The
properties query is authoritative for cardinality and must return fewer than
500 rows. The events query uses `page_size=500`, the supported JSON
`event_name=update_check` filter, and must return `cursor.hasMore=false`; do not
paginate an incomplete result. Each observation is one atomic, non-overlapping
pair of validated results. Start pairs no more often than every 30 seconds.

Before the zero baseline, freeze one inclusive Berlin calendar range with
`time_zone=Europe/Berlin`. It must cover a fixed 45-minute operator envelope:
the baseline, the valid request and its five-minute window, the invalid request
and its separate five-minute window, GET, the final poll, and a safety buffer.
Every actual send and deadline must remain inside that unchanged envelope and
map to the frozen Berlin dates. Never change dates, URLs, filters, expected
properties, or tuple values during a run.

Immediately before the zero baseline and immediately before each valid POST,
invalid POST, and GET, perform the same read-only deployment-drift check:
`BUNNY_DEPLOY_ENABLED` must be absent, no deployment-capable run may be queued
or active, and no new deployment-capable run may have appeared since the
pre-baseline snapshot. Do not change provider state as part of this check. Any
uncertainty or drift consumes the tuple and stops the attempt before the next
query or request.

The operator launches one private native-Curl wrapper process. It alone owns
the fixed npm lookup and the strict production order
`valid POST → invalid POST → GET`. The operator manually confirms every phase,
and the same wrapper process remains running for the entire sequence.

For valid and invalid, the browser imports the sanitized receipt and clears the
clipboard immediately. The operator then waits until the browser reports that
the phase's complete five-minute visibility gate passed. Only then does the
operator enter the fixed acknowledgment `RECEIPT_IMPORTED` in the same running
wrapper process. The wrapper does not observe or infer Rybbit visibility; it
trusts only this explicit operator acknowledgment and then emits the sanitized
marker `VS11_NEXT_PHASE_READY`. It emits no marker on failure. After GET, the
browser imports and acknowledges the sanitized receipt and clears the clipboard
immediately; the operator enters `RECEIPT_IMPORTED`, and the wrapper exits
without a next-phase marker. No later phase runs after a failure.

### Preserve the fixed data contracts

Reserve exactly one fresh, collision-resistant synthetic tuple immediately
before the baseline. Its fields are `project=palamedes`, a version matching
`0.0.0-live.<UTC timestamp>.r<96-bit lowercase hex>`, `os=verification`,
`arch=synthetic_x86_64`, `ci=true`, and `installedSince=<current UTC YYYY-MM>`.
Reservation consumes the tuple. Any clock, query, clipboard, dispatch,
response, receipt, or visibility ambiguity also consumes it, even if the
request may not have reached production. Never retry or reuse it.

The valid request is canonical UTF-8 JSON with exactly these keys in order:
`project`, `version`, `os`, `arch`, `ci`, and `installedSince`, with no
whitespace. The invalid request uses the same bytes followed by
`unexpected:true`. The expected Rybbit property object has exactly `project`,
`version`, `os`, `arch`, `mode:"ci"`, and `installedSince`; it has neither
`ci` nor `unexpected`.

The reducer fails closed unless every candidate is an ordinary event row with
event name `update_check`, the exact six-property object, and the required
privacy result. Missing privacy fields are neutral. For Rybbit's
provider-neutral fallbacks, only NUL/whitespace-only padding in the textual
geography fields is neutral, and the only neutral device tuple is no `device`
value with `device_type="Mobile"` and numeric `screen_width=0` and
`screen_height=0`. Any real, partial, string-typed, or otherwise different
value is identifying and stops the run. The reducer exposes opaque session and
user identifiers only through presence booleans.

Each sanitized receipt is a one-use object bound to the fixed schema version,
fresh run nonce, phase, request digest where applicable, Curl start/send
instant, exit code, whitelisted HTTP status, exact-body/latest-version result,
and `Allow` equality result where applicable. It contains no request, tuple,
response headers, stderr, or raw Curl output. The browser must import and
consume it within 30 seconds of the recorded send instant. Reject malformed,
stale, reused, late, mismatched, expired, or out-of-phase receipts.

Acknowledgment and visibility prove different facts. A valid HTTP response
proves that the service accepted the bounded Rybbit acknowledgment and returned
the npm result; it does not prove that the event is stored or visible. A Rybbit
row proves visibility; it does not excuse a failed or malformed client
response. Both must pass.

### Use the three clipboard stages

Use the observable clipboard only for these three bounded stages:

1. Copy a safe command containing only phase, nonce, and digest to the Terminal.
   Clear it immediately after import.
2. Copy exactly one tuple-bearing request for the wrapper's private import.
   Clear it immediately after import, then drop the browser and wrapper
   references and zero mutable byte buffers on a best-effort basis.
3. Copy only the sanitized receipt back to the browser. Leave it available
   until the browser has acknowledged the import, then clear it immediately.

The wrapper validates stage, size, digest, canonical byte form, and exact schema
before starting Curl. It accepts the request once and passes its bytes only to
Curl stdin with `--data-binary @-`. The tuple must never enter shell history,
arguments, environment variables, files, logs, DOM, console output,
screenshots, or published evidence. Clearing the clipboard does not prove
deletion from operating-system history, clipboard managers, or cross-device
synchronization; that remains an accepted risk for this synthetic,
non-identifying payload.

### Harden Curl and response handling

Invoke Curl directly without a shell. Put `-q` first; use the literal
`https://version-service.sebastian-software.de/check` URL; bypass proxies; and
disable config, netrc, cookies, redirects, retries, and alternate protocols.
Keep TLS verification enabled with `--connect-timeout 5`, `--max-time 15`, and
`--retry 0`. POST uses exactly `Content-Type: application/json`; GET has no body
or content-type header. No caller controls the URL, method, headers, or flags.

The stable-version lookup is a separate, fixed, unauthenticated native-Curl GET
to `https://registry.npmjs.org/@palamedes%2Fcli/latest` under the same network
restrictions and timeouts. Require Curl exit `0`, HTTP `200`, a bounded JSON
object, and exactly one valid SemVer `version`.

For each production phase, create one exclusive run-and-phase directory under
`/private/tmp` with mode `0700`. Create separate exclusive mode-`0600` files for
the response body and final response headers. Curl stdout may contain only one
fixed, bounded control record with whitelisted metadata; keep stderr private.
Reject pre-existing paths, symlinks, wrong ownership or permissions,
oversized content, malformed or multiple control records, and any response
file content observed before Curl finishes. Parse GET's final header block
privately and require exactly one case-insensitive `Allow` field whose trimmed
value is byte-equal to `POST`.

Delete the exact response and header files immediately after private validation
on every success or failure path, then remove only their verified empty
directory. Abort outstanding requests, clear timers and the observable
clipboard, invalidate actions and receipts, terminate the wrapper and Curl
child, close or reload the isolated Rybbit page, drop references, and zero
mutable buffers best-effort. Delete only the four exact helper artifacts after
sanitized evidence is complete. Ordinary deletion does not prove secure
erasure from filesystems, runtimes, Curl memory, clipboard services, or
provider storage.

### Run the baseline and three production phases

1. Repeat the read-only deployment-drift check immediately before establishing
   an unambiguous zero baseline for the exact tuple. Both bounded Rybbit lists
   must be complete, and the aggregate and event counts must be zero. Otherwise
   consume the tuple and stop without production traffic.
2. Look up the stable npm version immediately around the valid send. Repeat the
   drift check immediately before the valid POST, then send the valid body once
   and require Curl exit `0`, HTTP `200`, an exact one-key `latestVersion`
   response, and equality with npm. The browser imports the receipt within 30
   seconds and immediately clears the clipboard. Observe atomic Rybbit pairs
   through the fixed window, including one mandatory final pair started no
   earlier than five complete minutes after the actual send. Counts may be zero
   or one before the deadline, must never regress or exceed one, and must both
   be exactly one in the final pair. After the browser reports that the
   exact-property, privacy, and visibility gate passed, enter
   `RECEIPT_IMPORTED` in the same wrapper process and wait for
   `VS11_NEXT_PHASE_READY`.
3. Explicitly confirm the invalid phase, repeat the drift check immediately
   before the invalid POST, and send the invalid body once. Require Curl exit
   `0`, HTTP `400`, and byte-exact `{"error":"invalid_request"}`. The browser
   imports the receipt within 30 seconds and immediately clears the clipboard,
   then runs a separate full five-minute observation window. Both counts must
   remain exactly one. Only after the browser reports that gate passed, enter
   `RECEIPT_IMPORTED` in the same wrapper process and wait for the second
   `VS11_NEXT_PHASE_READY`.
4. Explicitly confirm the GET phase and repeat the drift check immediately
   before sending GET once. Require Curl exit `0`, HTTP `405`, byte-exact
   `{"error":"method_not_allowed"}`, and exact `Allow: POST`. The browser
   imports and acknowledges the receipt within 30 seconds, immediately clears
   the clipboard, and confirms that the final atomic Rybbit observation remains
   unchanged. Enter `RECEIPT_IMPORTED` in the same wrapper process; it ends
   without another next-phase marker. Report only sanitized terminal state;
   success requires `COMPLETE`, `success=true`, and `cleanupComplete=true`.

Timeout, disconnect, nonzero Curl exit after dispatch, partial observation,
count regression, count above one, envelope expiry, deployment drift, or any
malformed or ambiguous data is terminal. The call may have reached production,
so consume the tuple and never retry it. Record candidate and workflow times
only for operational correlation, not as proof of the active Bunny revision.

## 6. Integrate clients

The production endpoint has passed its service-readiness gate. Each client
repository still owns its integration, consent and opt-out behavior, release
authorization, and rollback:

- **Palamedes**: build the release with
  `PALAMEDES_UPDATE_ENDPOINT=https://version-service.sebastian-software.de/check`.
  Any other value fails the build (see ADR-027 in the Palamedes repository).
- Future Node CLIs use the planned `@sebastian-software/update-check` package
  from this repository.

After a client enables the endpoint, incident response must use that client's
rollback or disable mechanism as well as any server-side hostname withdrawal.

## Adding another project

1. Add the wire identifier and its npm package to `PROJECTS` in
   `packages/edge-script/src/script.mjs` (projects distributed outside npm
   need a new version-source entry — extend `latestVersion` accordingly).
2. Deploy through the manual workflow and verify the live contract with the new
   project id.
3. Wire the client in the project's own repository, including its
   `DO_NOT_TRACK` and per-tool opt-outs.

## Rollback

The version-service application is deployed. Disarming
`BUNNY_DEPLOY_ENABLED` prevents another publication but does not roll back or
contain the public service. For immediate server-side containment, withdraw the
public custom hostname while preserving redacted evidence for diagnosis.

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

For every enabled client, also invoke that client's owned rollback or disable
control. Do not assume that server rollback or hostname withdrawal immediately
reaches clients with cached configuration.

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
