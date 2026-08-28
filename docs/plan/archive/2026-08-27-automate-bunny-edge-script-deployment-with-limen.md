# Deploy Bunny Edge Script manually through GitHub Actions with Limen

**Plan status:** Implemented
**Source:** effective-flow plan
**Recommended workflow:** Feature (`effective-flow build`)

## Requirement

Deploy `packages/edge-script/src/script.mjs` to the production Bunny Edge Script only when an authorized operator manually starts the GitHub Actions workflow from current `main`, and only after the selected revision passes repository-native validation. Replace the current direct Bunny credentials in GitHub Actions with a Limen-managed, SOPS-encrypted deployment secret. Keep the procedure observable, serial, rollback-capable, and disabled until all external production prerequisites have been verified.

The existing workflow deploys on matching pushes and manual dispatches, but it is not gated on CI, references `BunnyWay/actions/deploy-script@main`, and expects `BUNNY_SCRIPT_ID` and `BUNNY_DEPLOY_KEY` as GitHub secrets. The target design removes the push trigger, keeps only `workflow_dispatch`, retains the official deploy action, and moves only the confidential, script-scoped deploy key into Limen. A Bunny account API key is intentionally not introduced because code publication needs no account-wide credential.

### Planning baseline

- Planning date: 2026-08-27.
- Local checkout: `5ac5b41`, two commits behind the refreshed remote `main` at `a5f02de76e3e57d0c83226203e955f3592e6cc4e`.
- Relevant local working state is not clean: `.gitignore`, `AGENTS.md`, and `docs/adr/effective-flow-project-setup.md` contain or represent the Effective Flow setup that remote `main` now tracks. Synchronization must reconcile these overlapping local files without discarding them.
- Before implementation, synchronize with `origin/main` without discarding the working state and re-read `.github/workflows/deploy.yml`, `DEPLOYMENT.md`, the Limen consumer documentation, and the referenced action releases. Stop and revise this plan if their credential or workflow contracts have changed materially.
- Current remote `main` has no Release Please configuration or release workflow. The interactive review decided on 2026-08-28 that deployment is an explicit manual GitHub Actions operation rather than a push- or release-triggered action.
- As of 2026-08-28, `@swernerx` and `@fastner` are the two verified write-capable repository administrators. The interactive review selected both as the explicit CODEOWNERS for deployment-sensitive files; re-verify their repository access before implementation.
- Reference implementation reviewed: [`sebastian-software/ssoft-hosting-setup@c1ed86c`](https://github.com/sebastian-software/ssoft-hosting-setup/tree/c1ed86c042e1e7af18b3490cbb013bb38bdfd5f5). Its transferable patterns are fail-closed CI credentials, `0600` temporary secret files with unconditional cleanup, manual workflow dispatch for recovery, and post-publish verification. It does not use Limen and its 1Password fallback, self-hosted runners, account-wide Bunny API key, Pull Zone middleware model, moving action tags, and broad publish permissions are not adopted here.

## Architecture decisions

- Use Limen environment mode with the environment name `production`. Commit the generated schema-v2 configuration, SOPS policy, managed Git attributes, and one encrypted dotenv source. Its ignored plaintext target contains exactly `BUNNY_DEPLOY_KEY`.
- Keep `BUNNY_SCRIPT_ID` as the non-secret repository variable `vars.BUNNY_SCRIPT_ID`. Keep `BUNNY_DEPLOY_ENABLED` as the rollout and emergency-disable variable.
- Use the Bunny script-specific deploy key instead of a Bunny account API key or Bunny-native GitHub OIDC. This was confirmed in the interactive review on 2026-08-28: Limen is a firm deployment requirement, and least-privilege code publication is preferred over account-wide active-release readback. The deploy action receives only `deploy_key`, so its authentication precedence cannot silently select a wider credential. Automating Bunny environment variables, DNS, Shield configuration, active-release API readback, or other account resources is a separate infrastructure change and is out of scope.
- Keep Limen private and use its supported two-part bootstrap model, as selected in the interactive review on 2026-08-28. GitHub retains the organization secret `LIMEN_INSTALL_TOKEN`, restricted to read-only release access to the private `sebastian-software/limen` repository. GitHub loads the private cross-repository action through its own scoped installation token, so the Limen source repository must separately allow organization repositories to use its actions and the organization/repository Actions policy must permit the pinned `sebastian-software/limen` action. The PAT cannot replace either Actions setting; publishing or vendoring the action is out of scope.
- Authenticate Limen with GitHub OIDC. Restrict the repository-specific Limen allowlist to this repository, `refs/heads/main`, the exact deployment workflow reference, and the `production` GitHub environment. Verify separately that the server-level event and runner policies allow `workflow_dispatch` and the approved GitHub-hosted runner class; deployment does not need `push` authorization.
- Use `workflow_dispatch` as the sole trigger. Starting the workflow is the explicit production authorization; neither pushes to `main` nor GitHub releases deploy by themselves.
- Add a boolean `verify_only` dispatch input that defaults to `false`. When selected, a dedicated `verify_preflight` job acquires the same production concurrency group and runs the same repository-owned freshness check as deployment, but has only `contents: read`, does not target the protected environment, and receives neither `id-token: write` nor Limen inputs. Verification mode is diagnostic evidence, not a deployment.
- Split resolution, validation, freshness eligibility, verification preflight, and deployment into separate jobs. The credential-free eligibility job runs after `pnpm agent:check`, fetches current `main`, and rejects a run whose immutable workflow anchor is already stale without entering the protected environment. Mutually exclusive `verify_preflight` and `deploy` jobs use the same concurrency group and the same checked-in local action for the fail-closed comparison after acquiring the production slot; only `deploy` targets the protected environment and may request OIDC or decrypt anything.
- Serialize manual production deployments with a dedicated concurrency group and do not cancel an in-progress publish. Because GitHub does not guarantee FIFO ordering, concurrency is not the freshness control: the early eligibility job safely rejects known-stale runs, and the deployment job re-fetches `main` and proves that the immutable workflow anchor is still current after acquiring its slot and immediately before OIDC/decryption. An operator re-dispatches any superseded run.
- Pin every external action used by the deployment workflow to a reviewed full commit SHA, with a release comment for maintainability. At planning time, Limen `decrypt-action-v0.10.0` resolves to `d205ac6e27f317e8b9f3c0072d85b61879574950`, and Bunny `deploy-script_0.5.1` resolves to `0cae4ba05838d2707b3d5ed779f15c6bc2b43267`. Re-resolve pins at implementation time and let Renovate maintain them afterwards.
- Treat the `production` environment as a deployment-record and main-ref restriction without a second reviewer approval: the authorized operator's `workflow_dispatch` is already the human production gate. Protect the workflow and credentials through `main`: require a pull request, at least one non-author approval, stale-approval dismissal, the repository CI check, code-owner review for deployment-sensitive files, and no ruleset bypass actors, force pushes, or deletion. Limen's exact ref/workflow/environment policy is the final provenance and decryption gate; it does not validate trusted workflow contents, so `.github/CODEOWNERS` must cover itself, `.github/workflows/deploy.yml`, `.github/actions/verify-deploy-anchor/**`, `.limen.yaml`, `.sops.yaml`, and `.limen/**` with both `@swernerx` and `@fastner` as owners. This explicit owner set was selected in the interactive review on 2026-08-28.
- Verify each publish with an invalid-payload smoke probe that must return `400 invalid_request`. Because configuration is checked before payload validation, this also distinguishes an unconfigured deployment (`503`). The hosted probe proves endpoint liveness and the deployed contract shape, but cannot by itself prove that no Rybbit event was emitted or attest the exact Bunny release. Repository tests must prove that the invalid-request path never calls the analytics sink, and the first-production checklist must confirm the absence of a Rybbit event. The existing one-time valid request and privacy checks remain operator verification before clients are enabled.
- Preserve the stronger verification principle from `ssoft-hosting-setup` without copying its credential model. That project polls Bunny's active release until its SHA-256 matches the local artifact, but the read endpoint uses the account API token. Do not introduce that wider credential merely for attestation. Keep the contract smoke test now and leave exact active-release verification as a follow-up only if Bunny exposes it through the script deploy key, a narrow read credential, or a trustworthy deploy-action output.
- Keep rollback on the current, hardened workflow. The interactive review decided on 2026-08-28 that an omitted `script_ref` deploys current `main`, while an optional full 40-character commit SHA may select any ancestor of the immutable main anchor; there is deliberately no minimum rollback floor or allowlist. Reject branches, tags, pull-request refs, non-ancestors, and commits without the expected script path. The current workflow anchor always supplies Limen configuration; only the candidate script is taken from the historical commit. Automatic rollback is out of scope; a failed post-publish probe marks the run failed and requires an explicit rollback dispatch.

## Affected files

| File                                                   | Description                                                                                                                                                                                                                                                             |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/deploy.yml`                         | Gate deployment on validation and credential-free freshness eligibility, add Limen decryption, least-privilege permissions, production environment, concurrency, immutable action pins, secure secret loading, post-deploy probing, cleanup, and manual rollback input. |
| `.github/actions/verify-deploy-anchor/action.yml`      | Implement the single repository-owned, fail-closed current-main comparison used by both the OIDC-free verification job and the real deployment job after they acquire the shared production concurrency slot.                                                           |
| `.github/actions/verify-deploy-anchor/verify.sh`       | Fetch current `main` and fail closed unless it still equals the immutable workflow anchor.                                                                                                                                                                              |
| `.github/actions/verify-deploy-anchor/verify.test.mjs` | Exercise current, queued-stale, malformed, and fetch-failure anchor states against real temporary Git repositories.                                                                                                                                                     |
| `.github/scripts/prepare-bunny-deploy-key.sh`          | Validate the Limen plaintext target, prevent Bunny authentication fallback, escape GitHub masking commands, and expose the original key only as a masked step output.                                                                                                   |
| `.github/scripts/prepare-bunny-deploy-key.test.mjs`    | Verify exact key preservation, masking, whitespace rejection, structural validation, and restrictive file permissions.                                                                                                                                                  |
| `.github/CODEOWNERS`                                   | Require both `@swernerx` and `@fastner` to own this file itself plus the workflow, local anchor-verification action, and Limen policy or encrypted-secret paths before changes reach protected `main`.                                                                  |
| `.limen.yaml`                                          | Add the schema-v2 recipient roster and the `production` source-to-target mapping generated by Limen.                                                                                                                                                                    |
| `.sops.yaml`                                           | Add the Limen-generated creation rule restricted to encrypted files under `.limen/`.                                                                                                                                                                                    |
| `.gitattributes`                                       | Add the Limen-managed merge and redacted-diff driver block.                                                                                                                                                                                                             |
| `.limen/dev/.gitkeep`                                  | Preserve the empty development directory generated by `limen init`.                                                                                                                                                                                                     |
| `.limen/production/.env.bunny-deploy.local.sops.env`   | Commit the SOPS-encrypted, script-scoped Bunny deploy key. Never commit its plaintext sibling.                                                                                                                                                                          |
| `.gitignore`                                           | Preserve the existing Effective Flow entry and ignore `.env.bunny-deploy.local`.                                                                                                                                                                                        |
| `DEPLOYMENT.md`                                        | Replace direct Bunny GitHub-secret setup with Limen onboarding, GitHub/Bunny prerequisites, rollout, rotation, verification, and rollback instructions.                                                                                                                 |
| `package.json`                                         | Discover the deployment-tooling tests through the repository test gate and exclude the Limen-generated `.sops.yaml` byte form from Oxfmt without changing standards-managed ignore files.                                                                               |

No application source, wire contract, Rybbit event shape, or client behavior changes are planned.

## Implementation details

### Approach

1. Rebase the implementation context onto the current `origin/main` while preserving the existing local setup changes. Record the reviewed action release SHAs and confirm that the official Bunny action still accepts `script_id`, `deploy_key`, and `file` with the documented authentication precedence.
2. Install or update the local Limen CLI to the reviewed `0.10.0` release, then run `limen init` rather than hand-authoring its managed files. Encrypt a temporary `.env.bunny-deploy.local` containing exactly the operator-provided `BUNNY_DEPLOY_KEY` into the `production` environment. Remove the plaintext immediately after encryption and verify that Git ignores the target.
3. Configure the external trust boundary before arming deployment:
   - expose the organization secret `LIMEN_INSTALL_TOKEN` to `version-service` only;
   - configure the private `sebastian-software/limen` repository to share its actions with organization repositories and confirm that the organization and `version-service` Actions policies allow the exact pinned action; treat this action-source access separately from the PAT used by Limen to download its CLI release;
   - add the Limen repository policy for `sebastian-software/version-service`, ref `refs/heads/main`, workflow ref `sebastian-software/version-service/.github/workflows/deploy.yml@refs/heads/main`, and environment `production`; separately verify the global Limen event and runner policies;
   - add `.github/CODEOWNERS` entries for itself, the deploy workflow, the local anchor-verification action, and all Limen policy/encrypted-secret paths; assign every entry to both `@swernerx` and `@fastner`, re-verify that each is an active user with write access at implementation time, and stop before arming deployment if either owner is not recognized by GitHub;
   - create the GitHub `production` environment and restrict it to `main`; configure a `main` ruleset that requires a pull request, at least one non-author approval, stale-approval dismissal, code-owner review, the repository CI check, no bypass actors, and no force-push or deletion;
   - set `BUNNY_SCRIPT_ID` and keep `BUNNY_DEPLOY_ENABLED` false until the first deployment is ready;
   - retain the Bunny-side `RYBBIT_ENDPOINT`, `RYBBIT_SITE_ID`, and secret `RYBBIT_API_KEY`, plus DNS, TLS, no-request-logging, and Shield rate-limiting configuration from `DEPLOYMENT.md`.
4. Add a credential-free resolver job with complete repository history. Require the manually dispatched workflow itself to run from `refs/heads/main` and capture immutable `github.sha` as the authorization anchor. A dispatch without an override selects that current-main anchor as its candidate. An optional rollback input accepts exactly one full 40-character commit SHA, resolves it once inside this repository, requires it to be any ancestor of the immutable anchor, and confirms that `packages/edge-script/src/script.mjs` exists; enforce no additional floor or allowlist. Add boolean `verify_only`, defaulting to `false`, and export its normalized value alongside only the anchor and resolved candidate SHAs; never re-resolve a moving branch later in the run.
5. Make the validation job check out the resolved candidate SHA without persisted Git credentials, install the pinned Node/pnpm toolchain, and run that revision's `pnpm agent:check`. This binds validation to the exact candidate later published.
6. Add a credential-free eligibility job after validation with only `contents: read`, no GitHub environment, and no OIDC permission. Fetch current `refs/heads/main` and set `eligible=false` unless it still equals the immutable workflow anchor, including for rollback runs; this ensures that every normal deploy and rollback uses the latest trusted workflow and Limen plumbing. Export only the immutable anchor, candidate SHA, and boolean eligibility result.
7. Implement `.github/actions/verify-deploy-anchor/action.yml` as the single local freshness primitive. Given the immutable anchor, it fetches `refs/heads/main`, compares the exact SHAs, records a non-secret result, and fails closed on mismatch or fetch/error conditions. Both terminal jobs check out the immutable workflow anchor and call this same local action only after acquiring the shared non-canceling production concurrency group.
8. Add mutually exclusive terminal jobs after validation and eligibility:
   - `verify_preflight` runs only when `eligible=true` and `verify_only=true`, has only `contents: read`, does not target the `production` environment, receives no Limen inputs or secrets, and finishes after the shared anchor check. It must have no `id-token: write` permission and no conditional secret-bearing steps.
   - `deploy` runs only when `eligible=true`, `verify_only=false`, and `BUNNY_DEPLOY_ENABLED=true`; it targets the `production` environment and grants only `contents: read` and `id-token: write`. After the shared anchor check succeeds, reject non-`main` workflow dispatches before invoking Limen or requesting an OIDC token.
9. In the deployment job, check out the immutable workflow anchor for the local verification action, `.limen.yaml`, `.sops.yaml`, and the encrypted production file. Check out the already resolved candidate SHA into a separate directory for the script file only. Never take Limen policy or workflow support files from the rollback candidate.
10. In `deploy`, use the immutable Limen action pin with `environment: production`, the explicit `limen-cli-v0.10.0` download version, and `LIMEN_INSTALL_TOKEN`. Do not print the action output or decrypt in pull-request workflows. Immediately require the decrypted dotenv target to be a regular file and set its mode to `0600`, mirroring the temporary-secret hygiene in `ssoft-hosting-setup` rather than assuming Limen's output mode.
11. Parse the decrypted dotenv file as data rather than sourcing it as shell code. Require exactly one non-empty `BUNNY_DEPLOY_KEY`, reject unknown or duplicate keys, register the value with GitHub masking, and expose it as a masked step output consumed only by the Bunny deploy step. Do not place it in job-wide `$GITHUB_ENV`, the probe environment, or cleanup environment.
12. Invoke the immutable Bunny deploy action with `vars.BUNNY_SCRIPT_ID`, the masked step output, and the candidate checkout's edge-script file. After publication, send the invalid contract probe to `https://version.sebastian-software.dev/check` and require both HTTP `400` and the exact `invalid_request` JSON body. Record the candidate SHA and timestamps in the job summary for operator correlation with the Bunny deployment record; label that correlation as operational evidence, not revision proof.
13. Add an unconditional cleanup step that deletes the decrypted plaintext target after successful and failed downstream steps. Upload neither plaintext nor runner environment files as artifacts, and do not cache them.
14. Remove the `push` trigger and its path filter entirely. Keep `workflow_dispatch` as the sole trigger for normal production deployment, initial rollout, secret-rotation proof, rollback, and non-publishing preflight verification.
15. Update `DEPLOYMENT.md` with the exact separation of responsibilities: Limen holds only the script deploy key; GitHub holds the Limen bootstrap token and non-secret variables; Bunny holds runtime Rybbit configuration. Include both Limen bootstrap channels, key rotation and compromise response, repository-specific and server-level Limen policies, protected-environment/ruleset prerequisites, first arming, non-publishing preflight verification, post-deploy checks, and rollback through a full `script_ref` SHA.
16. Roll out in order: merge while deployment is unarmed; finish Limen/GitHub/Bunny operator configuration; prove the queued freshness behavior with `verify_only=true`; set `BUNNY_DEPLOY_ENABLED=true` immediately before the first real manual dispatch from `main`; complete the smoke and live privacy checks; and leave the variable enabled only after success. If the first dispatch fails, disable the variable before another deployment attempt and diagnose or roll back explicitly. Future code changes never deploy merely by reaching `main`; an authorized operator dispatches each production release.

### API integration

- Limen decrypt action: `sebastian-software/limen/actions/decrypt`, environment mode `production`, GitHub OIDC audience from the Limen default, and an explicit CLI release.
- Bunny deploy action: `BunnyWay/actions/deploy-script`, authenticated with `script_id` plus `deploy_key`; the account-level `api_key` input remains unset.
- Production probe: `POST /check` with `Content-Type: application/json` and an intentionally invalid body; expected response is exactly the non-analytics `400 invalid_request` path.

### Edge cases

- When `BUNNY_DEPLOY_ENABLED` is absent or false and `verify_only` is false, a manual run may perform resolution, validation, and eligibility, but the production job does not enter its environment and no Limen decryption or Bunny publication occurs.
- When `verify_only=true`, the dedicated `verify_preflight` job runs even while `BUNNY_DEPLOY_ENABLED` is false so it can acquire the real concurrency group and execute the shared freshness action. It has only `contents: read`, does not enter the `production` environment, and cannot request OIDC, receive Limen inputs, decrypt, or publish even if the rollout variable is true; the mutually exclusive `deploy` job is skipped.
- Pushes, pull requests, tags, and releases never start the deployment workflow. A manual run from a non-main workflow ref is rejected by both the workflow guard and the Limen allowlist.
- A rollback input that is not a full commit SHA, is not reachable from protected `main`, or lacks the expected script path is rejected before validation.
- A technically eligible historical commit can predate current API, privacy, or runtime assumptions because the selected rollback policy has no floor. The operator must therefore choose an intentionally known historical state, inspect the candidate diff, and run the complete contract/privacy checklist after every rollback; the workflow records the selected SHA but does not claim semantic compatibility.
- Validation failure prevents OIDC minting, decryption, and publication.
- Missing Limen bootstrap access, an OIDC policy mismatch, a missing encrypted mapping, or a malformed plaintext secret fails before the Bunny action.
- A decrypted target that is missing, not a regular file, or cannot be restricted to mode `0600` fails before parsing or publication.
- Limen or SOPS output must never be logged. A partially decrypted target is removed even when a later step fails.
- Concurrent manual dispatches do not cancel an active publish. The early eligibility job rejects anchors that are already stale, and each mutually exclusive terminal job calls the same local freshness action after acquiring the concurrency slot. A queued deployment whose anchor became stale while waiting fails before Limen/OIDC/decryption; the operator re-dispatches from the latest `main` rather than relying on GitHub concurrency ordering.
- A Bunny publish failure stops before the probe. A probe failure after publication leaves the new release live but makes the run visibly failed; the operator uses the current workflow with `script_ref` to republish a known-good commit.
- Deploy-key rotation is fail-closed and assumes no overlap between old and new keys: disarm deployment, rotate or retrieve the replacement according to Bunny's then-current documented behavior, update only the encrypted production file, set the rollout gate immediately before one manual test, and disable it again if that test fails.
- Treat compromise of the script-specific deploy key as production-code compromise, not merely credential leakage. Disarm deployment, rotate the key, inspect active code and deployment history with an authorized operator credential, and rotate any runtime secret that malicious replacement code could have accessed or exfiltrated.
- If `@swernerx` or `@fastner` loses repository write access or is no longer recognized as a code owner, stop before arming or changing deployment. Repair and verify the explicit owner set before relying on code-owner review again.
- If future work must configure Bunny runtime secrets, DNS, Shield, or other account resources, stop and create a separate infrastructure plan; do not silently add a Bunny account API key to this workflow.

## Acceptance criteria

- [ ] `.github/workflows/deploy.yml` has `workflow_dispatch` as its only trigger; pushes, pull requests, tags, and releases cannot start a production deployment.
- [ ] `verify_only` is a boolean manual input defaulting to false. When true, a dedicated `verify_preflight` job with only `contents: read`, no protected environment, no Limen inputs, and no `id-token` permission acquires the real production concurrency group and executes the shared preflight; the mutually exclusive `deploy` job cannot run, regardless of `BUNNY_DEPLOY_ENABLED`.
- [ ] A manual dispatch from current protected `main` runs `pnpm agent:check` for the selected candidate and publishes only after that command succeeds.
- [ ] The deployment job uses the `production` GitHub environment, `contents: read`, `id-token: write`, a non-canceling production concurrency group, and no second environment approval.
- [ ] A credential-free eligibility job with only `contents: read` proves after validation and before the production environment that the immutable workflow anchor still equals current `main`; a run already superseded at that point reports `eligible=false` and cannot reach the deploy job, including when it carries a rollback SHA.
- [ ] `.github/actions/verify-deploy-anchor/action.yml` is the single fail-closed implementation used after concurrency acquisition by both `verify_preflight` and `deploy`; a deployment superseded while queued fails before Limen/OIDC/decryption and cannot publish.
- [ ] Limen schema v2 maps the encrypted production dotenv source to ignored `.env.bunny-deploy.local`; `limen sync --check` succeeds and no plaintext secret is tracked or left after the job.
- [ ] The Limen action and Bunny deploy action are referenced by reviewed full commit SHAs with version comments; no deployment action uses `@main` or another moving reference.
- [ ] `BUNNY_DEPLOY_KEY` is the only Bunny credential decrypted in GitHub Actions; its regular plaintext file is restricted to mode `0600`, the value is masked before use, it is never printed or uploaded, and the file is removed in an unconditional cleanup step.
- [ ] No Bunny account API key is introduced. `BUNNY_SCRIPT_ID` and `BUNNY_DEPLOY_ENABLED` are repository variables, while `LIMEN_INSTALL_TOKEN` remains the narrowly scoped organization bootstrap secret.
- [ ] GitHub can resolve the pinned private Limen action because the Limen source repository shares actions with the organization and the organization/repository Actions policies allow it; this access is verified separately from `LIMEN_INSTALL_TOKEN` CLI-release access before deployment is armed.
- [ ] Limen's repository entry authorizes only the exact repository, main ref, workflow ref, and `production` environment; separate global checks confirm the allowed events and GitHub-hosted runner policy.
- [ ] GitHub protects `main` with the documented pull-request, approval, stale-review, code-owner, CI, force-push, deletion, and zero-bypass settings; the `production` environment accepts deployments only from `main`, and `.github/CODEOWNERS` demonstrably protects itself, the deploy workflow, the local anchor-verification action, and every Limen-sensitive path with both `@swernerx` and `@fastner` recognized as code owners.
- [ ] Every successful publication passes the automated smoke probe with HTTP `400` and the exact `invalid_request` body; repository tests prove that this invalid path does not call analytics, and the first-production checklist verifies Rybbit absence. Documentation describes these as separate liveness, code-path, and operational privacy evidence rather than revision attestation.
- [ ] A manual dispatch with no `script_ref` deploys the run's current-main anchor. An optional full historical commit SHA may select any ancestor of that anchor, with no additional floor or allowlist; the workflow validates that exact candidate, deploys only its script through the anchor's workflow and Limen configuration, and records the resolved SHA and timestamps for non-attesting operational correlation.
- [ ] The first armed manual deployment passes the existing valid request, invalid request, Rybbit neutralization, no-logging, DNS/TLS, and rate-limiting checks before any client release enables the endpoint.
- [ ] `DEPLOYMENT.md` accurately documents the Limen bootstrap, secret ownership, setup order, rotation, arming, manual trigger, verification, and rollback.
- [ ] Every external action in the workflow—including checkout, pnpm setup, Node setup, Limen decrypt, and Bunny deploy—is pinned to a reviewed full commit SHA with a version comment.
- [ ] `pnpm agent:check`, `git diff --check`, and the hosted deployment workflow all finish successfully for the implementation commit.

## Validation plan

- Run `limen sync --check` to verify recipient, SOPS-policy, mapping, and managed-file consistency.
- In an isolated copy, decrypt the `production` environment, assert that the target contains exactly one non-empty `BUNNY_DEPLOY_KEY`, confirm `git check-ignore .env.bunny-deploy.local`, then remove the plaintext.
- Inspect `git status --short` and search for the operator-supplied secret value without printing it; confirm that only encrypted SOPS content and the non-secret variable name are tracked.
- Run `pnpm agent:check` and `git diff --check` from the repository root.
- Review the workflow YAML for minimal permissions, immutable pins for every external action, guarded triggers, immutable candidate resolution, validation dependency, a separate credential-free eligibility job, mutually exclusive verification/deployment jobs, the shared local post-concurrency freshness action, absence of `id-token` and secret-bearing inputs in `verify_preflight`, immutable-anchor Limen checkout, separate candidate checkout, environment, concurrency, step-scoped secret handling, cleanup, and absence of artifact/cache handling after decryption.
- Exercise the resolver and eligibility logic against a temporary Git history containing a normal candidate, an eligible rollback ancestor, a workflow anchor superseded during validation, and an anchor superseded while its deployment job waits for the concurrency slot. Verify that the first two retain the intended candidate only while their anchor is current, that the early-stale run exits in eligibility, and that the queue-stale run exits in the deployment preflight before Limen/OIDC/decryption. Confirm the queue-time behavior with hosted `verify_only=true` manual dispatches while deployment remains disarmed, and inspect the run to prove that no Limen, OIDC-token-request, decryption, or Bunny step executed.
- Verify Limen with `limen policy allowed list`, `limen policy events list`, and `limen policy runners list`. Verify GitHub protection and the `production` environment through the GitHub API or settings UI, retaining redacted evidence of the configured rules rather than secret values.
- Inspect the Limen source-repository sharing setting and the organization/repository Actions policy through GitHub settings or API. Merge the implementation while unarmed and confirm that no deployment workflow starts from the push. Then dispatch it manually from `main` and confirm that resolution, validation, and eligibility run while the environment/OIDC/decrypt/publish path remains skipped.
- After operator prerequisites are complete, dispatch the workflow from `main`, inspect the GitHub deployment record and job result, confirm the automatic invalid-request probe, and run the full live contract/privacy checklist from `DEPLOYMENT.md`.
- Trigger one controlled rollback to an operator-selected historical ancestor in a non-production verification window, confirm the recorded candidate SHA and Bunny deployment record, run the complete contract/privacy checklist, then dispatch again without `script_ref` to redeploy current `main`, proving the default and rollback paths use current credential plumbing.
- Perform one fail-closed deploy-key rotation rehearsal: disarm, update the encrypted Limen source with the current Bunny rotation semantics, re-arm only for the manual proof, and confirm that failure returns the repository to the disarmed state.

## Assumptions and open points

- The intended scope is code publication for one pre-created standalone Edge Script, not Bunny infrastructure provisioning.
- Exact SHA-256 attestation of Bunny's active release is deliberately deferred. The reviewed `ssoft-hosting-setup` implementation proves the pattern, but its readback depends on the broader Bunny account API token and its Pull Zone middleware artifact model does not directly fit this standalone Edge Script.
- GitHub-hosted runners are used. If a persistent self-hosted runner is introduced, strengthen cleanup and workspace isolation before enabling decryption there.
- Repository administrators can configure `LIMEN_INSTALL_TOKEN`, the Limen policy, GitHub environment, branch ruleset, Bunny script variables/secrets, DNS/TLS, logging, and rate limiting. The plan neither invents nor records their values.
- The production hostname remains `version.sebastian-software.dev`, and the current wire contract remains unchanged.

## Implementation outcome

The repository implementation was completed on 2026-08-28 in an isolated Effective Flow delivery
worktree based on `a5f02de76e3e57d0c83226203e955f3592e6cc4e`. It remains default-disarmed: merging
the implementation cannot publish to Bunny, and operators must finish the hosted prerequisites in
`DEPLOYMENT.md` before setting `BUNNY_DEPLOY_ENABLED=true` for a manual run.

Implemented repository behavior:

- `workflow_dispatch` is the only trigger. A blank `script_ref` selects the immutable current-main
  anchor; an explicit rollback requires a full ancestor SHA containing the expected script.
- Candidate validation, credential-free eligibility, and the shared serialized freshness action
  bind publication to the validated revision while keeping workflow and Limen configuration on the
  latest trusted anchor.
- `verify_preflight` has no environment, OIDC, Limen, or Bunny capability. Only the explicitly
  armed `deploy` job enters `production`, requests OIDC for Limen, decrypts the script-scoped key,
  and publishes through the immutable Bunny action pin.
- The deploy-key parser rejects malformed or whitespace-altered values, prevents an empty trimmed
  value from selecting Bunny OIDC, masks workflow-command-sensitive characters, and removes the
  plaintext unconditionally. The committed SOPS payload contains the only confidential deployment
  input; its ignored plaintext sibling is absent.
- Both serialized terminal jobs and the production probe have bounded timeouts. The probe verifies
  the exact `400` / `{"error":"invalid_request"}` contract and records only operational SHA
  correlation, not active-release attestation.
- `DEPLOYMENT.md` now covers Limen 0.10.0 bootstrap, private-action access, hosted policy setup,
  safe encryption and rotation, unarmed verification, manual deployment, rollback, privacy checks,
  and compromise response.

Implementation-time deviations and additions:

- Current pnpm 11 guidance uses `pnpm/setup@84cb39b217b10273981911c288cd62326dc7c6d2`
  instead of the older `pnpm/action-setup` plus `actions/setup-node` pair.
- `limen init` generated `.limen/dev/.gitkeep`; it is retained as generated scaffolding.
- Review introduced the testable secret-preparation script, bounded terminal timeouts, and guarded
  operator bootstrap steps. Oxfmt excludes only `.sops.yaml` through the package scripts because
  Limen owns that generated file's byte representation and `.oxfmtignore` is standards-managed.

### Test results

- `PNPM_CONFIG_PM_ON_FAIL=ignore pnpm agent:check` passed lint, formatting, type checking, build,
  standards, eight application tests, and eight deployment-tooling tests.
- `git diff --check` passed.
- `bash -n` passed for both repository-owned shell scripts.
- `CI=true limen sync --check` passed after encryption and confirmed that `.sops.yaml` matches
  `.limen.yaml`.
- The encrypted production source is nonempty and contains exactly one encrypted
  `BUNNY_DEPLOY_KEY` plus SOPS metadata. The plaintext target is absent, ignored, and untracked.

Hosted GitHub, Limen, and Bunny controls and an actual manual deployment remain rollout evidence,
not repository-local implementation evidence. The procedure stays disarmed until those checks pass.

## Review findings

**Date:** 2026-08-28
**Reviewer:** `effective-flow-code-validator` (tooling and documentation)

### Summary

| Status                 | Count |
| ---------------------- | ----: |
| Fixed                  |     5 |
| Open / Not implemented |     0 |

All findings were fixed. The review covered deploy-key normalization and masking, bounded terminal
jobs and probe execution, interruption-safe encryption, rollback re-arming, and inherited shell
tracing during secret entry. No external review report was required.

## Plan review

**Result:** Approved

### Summary

| Area            | Critical | Important | Note |
| --------------- | -------: | --------: | ---: |
| Architecture    |        0 |         8 |    0 |
| Security        |        0 |        11 |    1 |
| Data protection |        0 |         0 |    0 |
| Error cases     |        0 |         0 |    0 |
| Testability     |        0 |         2 |    1 |
| Scope           |        0 |         0 |    0 |
| Maintainability |        0 |         0 |    0 |

### Findings

- **Architecture — Important, incorporated:** A historical checkout could omit trusted Limen files and accept an arbitrary ref. The revised plan takes workflow and Limen configuration from the run's immutable main anchor, resolves a full candidate SHA, proves ancestry, validates that candidate, and deploys only its script file.
- **Security — Important, incorporated:** Job-wide secret export exposed the deploy key to unrelated later steps. The revised plan masks it and passes it only as a step output to the Bunny action.
- **Security — Important, incorporated:** Limen's repository policy was conflated with server-wide event and runner policy. The revised prerequisites and validation check them separately.
- **Security — Important, deliberately addressed with a compensating control:** A required GitHub-environment reviewer would add a second human gate after an operator already dispatched the deployment manually. The plan instead treats `workflow_dispatch` as production authorization and requires protected `main` with non-author approval, stale-review dismissal, code-owner review, CI, and no bypass actors, while the environment and Limen policy both restrict deployment to `main` and the exact workflow.
- **Security — Note:** Limen removes the Bunny deploy key from GitHub secret storage but still requires `LIMEN_INSTALL_TOKEN` to download the private action and CLI. The plan limits that token to read-only access to the Limen repository and records it as an explicit bootstrap dependency.
- **Testability — Important, incorporated:** The post-publish request cannot attest the exact Bunny revision. It is now scoped to liveness and contract smoke testing, while the resolved SHA is correlated with the deployment record.
- **Architecture — Important, incorporated:** A non-canceling concurrency group serializes publication but does not guarantee FIFO ordering. The revised plan requires every manual run's immutable anchor to remain current immediately before deployment, so a queued or slower stale dispatch cannot publish last.
- **Architecture — Important, incorporated:** The separate eligibility job left a queue-time freshness gap between its check and acquisition of the production concurrency slot. The deployment job now repeats the immutable-anchor comparison after acquiring that slot and fails before Limen/OIDC/decryption if `main` advanced while the run waited.
- **Architecture — Important, incorporated:** A disarmed hosted run skipped the deployment job and therefore could not exercise its post-concurrency freshness preflight. The revised plan adds a default-off `verify_only` dispatch mode whose dedicated credential-free job acquires the same production concurrency group and calls the same local preflight action without entering the protected environment or gaining secret-bearing capabilities.
- **Architecture — Important, incorporated:** The hosted supersession exercise was unsafe while freshness lived inside an armed production job. The revised plan moves it into a separate credential-free eligibility job that a manual workflow can run and observe while deployment remains disarmed.
- **Architecture — Important, incorporated:** Rollback ancestry against a moving `main` was ambiguous. The revised plan captures the workflow-trigger SHA as an immutable main anchor, resolves the full candidate SHA once, and uses that pair throughout validation and deployment.
- **Architecture — Important, resolved by user decision:** The deployment trigger was unresolved after confirming that this repository has no Release Please manager. On 2026-08-28 the user chose explicit manual GitHub Actions deployment; the plan now removes all push and release triggers and treats `workflow_dispatch` as the production authorization event.
- **Architecture — Important, resolved by user decision:** The permitted rollback history was undefined. On 2026-08-28 the user chose current `main` as the no-input default and any full-SHA ancestor as an explicit rollback target, without a floor or allowlist; the plan compensates by retaining current workflow/Limen plumbing and requiring full post-rollback contract and privacy checks.
- **Security — Important, incorporated:** Limen proves workflow provenance but does not make the workflow contents trustworthy. The revised plan adds code-owner coverage and required review for the deployment workflow and Limen paths, with no ruleset bypass actors.
- **Security — Important, incorporated:** A CODEOWNERS file that does not own itself can weaken all protected-path reviews. The revised plan assigns `.github/CODEOWNERS` to the same designated deployment/security owners and includes that rule in hosted protection verification.
- **Security — Important, incorporated:** The bootstrap plan conflated PAT access to Limen CLI releases with GitHub's private cross-repository action loading. The revised prerequisites independently require source-repository action sharing and an organization/repository Actions policy that permits the pinned action.
- **Security — Important, resolved by user decision:** The Bunny authentication model was still open between a script-scoped deploy key, Bunny OIDC, and an account API key. The user selected the script-specific deploy key in Limen on 2026-08-28; the plan now excludes wider credentials and treats key compromise as production-code compromise with runtime-secret incident response.
- **Security — Important, resolved by user decision:** The Limen bootstrap boundary was open between private supported consumption, publishing the action, and vendoring it. The user selected the private Limen model on 2026-08-28; the plan now keeps source-action sharing and the narrowly scoped CLI-download PAT as separate prerequisites and excludes publishing or copying the action.
- **Security — Important, incorporated:** Deploy-key rotation assumed overlapping Bunny keys without evidence. The revised sequence disarms first, assumes no overlap, re-arms only for a manual proof, and returns to the disarmed state on failure.
- **Security — Important, resolved by user decision:** The CODEOWNERS identity was undefined. The user selected `@swernerx` and `@fastner` on 2026-08-28; the plan requires both as explicit owners for `.github/CODEOWNERS` itself, the deployment workflow, and all Limen policy or encrypted-secret paths, with hosted verification that GitHub recognizes each owner.
- **Security — Important, incorporated:** A verification branch inside an `id-token: write` deployment job could skip Limen in practice but could not truthfully be capability-free. The plan now uses mutually exclusive jobs: `verify_preflight` has only `contents: read` and no environment or Limen inputs, while only the armed, non-verification `deploy` job can receive OIDC permission and deployment secrets.
- **Testability — Important, incorporated:** The HTTP smoke probe cannot prove analytics absence. The revised criteria separate hosted response evidence, repository tests of the invalid-request branch, and manual first-production inspection of Rybbit.
- **Testability — Note:** A local plan cannot prove external Limen policy, Bunny configuration, or GitHub protection state. The rollout therefore has explicit unarmed, hosted-dispatch, live-contract, privacy, protection-inspection, and rollback gates.

## Open points

- No open points.
