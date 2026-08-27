# Deployment guide

This guide takes the edge script from this repository to a live
`https://version.sebastian-software.dev/check` endpoint. Work through it in
order; every step is independently verifiable. Client releases (for example
Palamedes) must not embed the endpoint before the final verification step has
passed.

## Prerequisites

- Bunny.net account access with permission to create Edge Scripts and manage
  the DNS zone for `sebastian-software.dev` (domain onboarding is automated by
  `ssoft-hosting-setup`).
- The self-hosted Rybbit instance URL, a site for CLI telemetry, and an API
  key for it (Rybbit dashboard → site settings → API keys).
- Admin access to this GitHub repository for secrets and variables.

## 1. Create the edge script

1. Bunny dashboard → **Edge Platform** → **Scripting** → **Add Script**.
2. Type **Standalone**, name `version-service`.
3. Note the script's default hostname; it is the CNAME target for step 4.

## 2. Configure the environment

Script → **Env Configuration**:

| Name              | Kind     | Value                                                  |
| ----------------- | -------- | ------------------------------------------------------ |
| `RYBBIT_ENDPOINT` | variable | Rybbit instance origin, e.g. `https://rybbit.example`  |
| `RYBBIT_SITE_ID`  | variable | numeric site id of the CLI-telemetry site              |
| `RYBBIT_API_KEY`  | secret   | API key for that site (secrets cannot be viewed later) |

The script fails closed with `503 service_unconfigured` while any of these is
missing, so a half-configured deployment never answers or counts checks.

Check the Rybbit API rate limit before real adoption: keys are limited to
500 requests per 10 minutes (~72k/day). Verify whether our installation can
raise it, and revisit sink batching or one key per project when the daily
request curve approaches that ceiling.

## 3. Wire GitHub deployments

1. Script → **Deployments** → **Settings**: copy the script id and deploy key.
2. Repository → Settings → Secrets and variables → Actions:
   - secret `BUNNY_SCRIPT_ID` = script id
   - secret `BUNNY_DEPLOY_KEY` = deploy key
   - variable `BUNNY_DEPLOY_ENABLED` = `true`
3. Run the **Deploy** workflow once by hand (workflow_dispatch). Afterwards
   every push to `main` that changes `packages/edge-script/src/script.mjs`
   redeploys automatically.

While `BUNNY_DEPLOY_ENABLED` is unset the workflow is skipped, so CI stays
green before the Bunny side exists.

## 4. Attach the hostname

1. Script settings → hostnames: add `version.sebastian-software.dev`.
2. DNS: CNAME `version.sebastian-software.dev` to the script's default
   hostname (via `ssoft-hosting-setup` or manually in the Bunny DNS zone).
3. Issue/confirm the TLS certificate in the same settings screen and wait for
   `https://version.sebastian-software.dev` to serve it.

## 5. Verify the live contract

All four checks must pass before any client release embeds the endpoint:

```bash
curl -sS -X POST https://version.sebastian-software.dev/check \
  -H "content-type: application/json" \
  -d '{"project":"palamedes","version":"1.0.0","os":"linux","arch":"x86_64","ci":false,"installedSince":"2026-08"}'
```

1. The call above returns `200` with `{"latestVersion":"…"}` matching the
   current `@palamedes/cli` version on npm.
2. An invalid payload (add any extra field) returns `400 invalid_request`;
   `GET` returns `405`.
3. The Rybbit site shows one `update_check` event per call with the six
   aggregate properties, no client IP-derived geo data, and the fixed
   `version-service` user agent.
4. No request logging is active: the script's Bunny logging/observability
   settings are off, and Rybbit shows no identifying fields.

## 6. Enable clients

Per project, after step 5:

- **Palamedes**: build the release with
  `PALAMEDES_UPDATE_ENDPOINT=https://version.sebastian-software.dev/check`.
  Any other value fails the build (see ADR-027 in the palamedes repository).
- Future Node CLIs use the planned `@sebastian-software/update-check` package
  from this repository.

## Adding another project

1. Add the wire identifier and its npm package to `PROJECTS` in
   `packages/edge-script/src/script.mjs` (projects distributed outside npm
   need a new version-source entry — extend `latestVersion` accordingly).
2. Deploy (step 3) and verify (step 5) with the new project id.
3. Wire the client in the project's own repository, including its
   `DO_NOT_TRACK` and per-tool opt-outs.

## Rollback

Re-run the **Deploy** workflow from an older commit (workflow_dispatch on that
ref), or restore a previous version in the Bunny dashboard's script editor.
Configuration and hostname are untouched by deploys, so rollback is only the
script file.
