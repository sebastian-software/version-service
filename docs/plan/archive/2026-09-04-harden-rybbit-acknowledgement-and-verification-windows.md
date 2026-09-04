# Harden Rybbit acknowledgement and verification windows

**Plan status:** Implemented
**Source:** effective-flow plan
**Recommended workflow:** Bugfix (`effective-flow fix`)

## Requirement

Eliminate the false-negative verification path and false-success acknowledgement path documented in `.effective-flow/investigation/investigation-2026-09-04-rybbit-query-timezone-false-negative.md` without changing the public `/check` contract.

First, the production verification procedure must not miss an event when a UTC request timestamp falls on the following calendar day in `Europe/Berlin`. Second, the edge script must not treat every Rybbit HTTP 2xx response as proof that Rybbit accepted the event: Rybbit v2.6.0 also returns HTTP 200 for several explicit “event not tracked” outcomes. The service must continue to fail closed with `503 {"error":"analytics_unavailable"}` whenever analytics acceptance cannot be established.

This is a Bugfix because it corrects unexpected verification and upstream-response behavior. It does not add a new product capability or change the six-field client request schema.

## Architecture decisions

- Pin the edge-side acceptance check to the deployed Rybbit v2.6.0 contract. Check `status === 200` before reading the body, parse JSON semantically, and accept only a non-null, non-array object whose sole own enumerable key is `success` and whose value is boolean `true`. Do not use raw-body byte equality or require a response `Content-Type`. Non-200 responses, malformed or unreadable bodies, scalar values, missing or false `success`, and additional fields fail closed. Exact shape matching is intentionally upgrade-sensitive so an upstream contract change cannot silently produce uncounted successful `/check` responses.
- Bound the Rybbit response body to 1 KiB while streaming. Reject overflow and read failure before JSON parsing, regardless of whether `Content-Length` is missing, inaccurate, or valid. The deployed acknowledgement bodies are far smaller, so the bound preserves normal operation while preventing an unbounded upstream-controlled allocation on the public route.
- Preserve the current public error behavior. A rejected or indeterminate analytics acknowledgement makes `countRequest` return false, and `handle` returns the existing `analytics_unavailable` response without exposing the upstream body.
- Keep persistence verification separate from acknowledgement verification. The Rybbit response proves request acceptance or enqueueing only; the subsequent read-only analytics query proves that exactly one event became visible.
- Make the operator-controlled live check deterministic in `DEPLOYMENT.md`. Precompute the inclusive Berlin query date range expected to cover the request and its full five-minute post-request visibility interval. After the zero baseline, record the actual UTC request instant immediately before sending, derive the actual five-minute deadline, and confirm that both boundaries still map to the precomputed date range. Never derive a Rybbit local date by truncating the UTC timestamp.
- Retain the existing manual, one-use production workflow. Do not add a verification script or extend the automated invalid-request deployment probe: doing so would mix read credentials and deliberate production telemetry into deployment automation.

## Affected files

| File                                       | Description                                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `packages/edge-script/src/script.mjs`      | Validate the Rybbit v2.6.0 HTTP status and response body before reporting analytics success.                                        |
| `packages/edge-script/src/script.test.mjs` | Model Rybbit response bodies and add handler-level fail-closed regression cases.                                                    |
| `DEPLOYMENT.md`                            | Define a timezone-safe, exact-tuple Rybbit observation procedure and the distinction between acknowledgement and stored visibility. |

## Implementation details

### Approach

1. Before editing, use a clean isolated worktree based on `origin/main` and verify that the three affected files still match the planning baseline `1c85c04f79e18f404196a3457eb0c852e0b546de`. Re-read this plan if the Rybbit response contract, deployment procedure, or repository validation commands have changed.
2. Extend the edge-script fetch stub so tests can supply both an arbitrary Rybbit status and body while its successful default models `{"success":true}`. Add a whitespace-formatted positive JSON fixture to prove semantic JSON parsing rather than raw serialized-string equality.
3. Add handler-level regression coverage before changing production logic. Preserve the existing valid-request and non-2xx cases, then use the literal Rybbit v2.6.0 discard bodies: `"Site over monthly limit, event not tracked"`; `{"success":true,"message":"Event not tracked - bot detected using isbot"}`; the corresponding `header heuristics`, `client signals`, and `desktop 800x600` bot messages; `{"success":true,"message":"Event not tracked - IP excluded"}`; and `{"success":true,"message":"Event not tracked - country excluded"}`. Also cover malformed JSON, an empty object, `success: false`, a scalar, an array, and any otherwise successful object with an additional field.
4. Prove the exact status and readable-body boundaries explicitly: HTTP 201 with `{"success":true}` must fail closed; a response whose body stream rejects must fail closed; and a body of 1,025 bytes must fail closed. Include a successful chunked or otherwise length-unknown response within 1 KiB so the implementation does not accidentally require `Content-Length`. Keep the existing non-2xx regression.
5. Change the private `countRequest` path to accept only the exact deployed success response. Add a private bounded-stream reader for the Rybbit response with an explicit 1 KiB limit; cancel and reject on overflow, then decode and parse only the accepted bytes. Keep status validation, stream handling, decoding, and JSON parsing inside the existing `try` boundary so transport, timeout, body-read, overflow, decoding, and JSON failures all return false. Do not export a new helper solely for testing and do not log or return the Rybbit response body.
6. Update the live-contract runbook to precompute the inclusive `Europe/Berlin` query date range expected to cover the request and its full five-minute post-request visibility interval. Use that date range with the full fresh tuple for the zero baseline. Immediately before sending, record the actual UTC request instant and derive the deadline as that instant plus five minutes; convert both actual boundaries to Berlin dates and send exactly once only if they equal the precomputed baseline range. Otherwise consume the tuple and stop without sending. Poll the unchanged date range through the actual deadline.
7. Add the concrete regression example that `2026-09-03T22:21:00Z` is `2026-09-04 00:21:00` in Berlin and therefore cannot be found by a single-day Berlin query for `2026-09-03`.
8. Define the six synthetic, non-identifying request values once and show their exact stored-property mapping: `project`, `version`, `os`, `arch`, `ci` to `mode`, and `installedSince`. Require the baseline and post-request queries to reuse the identical `event_name=update_check` and all six stored properties, and explicitly forbid reusing `.11.2`.
9. Provide a copy-pasteable timezone-aware conversion command, or an equivalently deterministic operator mechanism, that produces `start_date`, `end_date`, and `time_zone=Europe/Berlin` from the two UTC boundaries. Do not rely on mental conversion or the workstation's implicit local timezone.
10. Clarify in the runbook that HTTP acknowledgement and Rybbit visibility are separate gates: require a zero baseline before the request, capture the valid request's HTTP status and body independently, and require exactly one matching stored event afterward. A missing, duplicate, ambiguous, or contract-mismatched result consumes the tuple and stops the run.

### API integration

- Request construction remains unchanged: `POST <RYBBIT_ENDPOINT>/api/track` with the configured Bearer credential, site ID, `custom_event` type, `update_check` name, neutralized transport identity, and the six aggregate properties.
- Accepted upstream response: HTTP 200 and exactly one JSON field, `success`, with boolean value `true`.
- Read at most 1,024 response-body bytes through the stream. Missing or dishonest `Content-Length` never bypasses this bound and is not itself a rejection reason.
- Every other response is an unavailable analytics outcome. The client-facing response remains HTTP 503 with the existing body and contains no upstream detail.
- The implementation is deliberately coupled to the deployed Rybbit response contract. A Rybbit upgrade must revalidate this boundary before deployment rather than widening acceptance speculatively.

### Edge cases

- The actual request time plus its five-minute visibility interval maps to a different Berlin date range than the one used for the zero baseline.
- The five-minute observation interval itself crosses Berlin midnight and therefore requires a two-date inclusive local range.
- Rybbit returns HTTP 200 with a plain-text quota message.
- Rybbit returns HTTP 200 with `success: true` plus an “event not tracked” message.
- Rybbit returns HTTP 200 with malformed, empty, scalar, false-success, or unexpectedly extended JSON.
- Rybbit returns HTTP 201 with the otherwise accepted JSON body.
- Rybbit returns a non-200 status or its response body cannot be read.
- Rybbit returns a body larger than 1 KiB, including a chunked body or one whose declared length is missing or inaccurate.
- The actual request boundaries would require the precomputed query date range to change; the request must not be sent.
- The Rybbit response is accepted but the exact event is not visible, or is visible more than once, during the observation window; live verification stops without retrying the consumed tuple.

## Acceptance criteria

- [ ] A valid handler request returns the existing HTTP 200 result only when the Rybbit response has status exactly 200 and parses to a non-null, non-array object whose sole own enumerable key is `success` with boolean value `true`; insignificant JSON whitespace is accepted.
- [ ] Each known Rybbit v2.6.0 HTTP-200 discard form, plus malformed or unexpected response shapes, produces the existing HTTP 503 `analytics_unavailable` result and leaks no upstream response detail.
- [ ] HTTP 201 with the accepted JSON shape and a body-read rejection both produce the existing HTTP 503 result.
- [ ] The Rybbit response reader accepts a valid length-unknown body within 1 KiB, rejects a 1,025-byte body, and cannot be bypassed by a missing or inaccurate `Content-Length`.
- [ ] Existing neutralized IP, user-agent, six-property payload, validation, caching, and non-2xx behavior remain covered and unchanged.
- [ ] `DEPLOYMENT.md` requires a fresh one-use tuple, a query date range fixed before the baseline, an actual five-minute deadline measured from the recorded request instant, and a fail-closed stop before sending when the actual boundaries map to a different date range.
- [ ] `DEPLOYMENT.md` defines one synthetic six-field request, its exact six-property Rybbit mapping including `ci` to `mode`, identical baseline/post-request filters, a deterministic timezone-aware conversion mechanism, the midnight regression example, and the prohibition on reusing `.11.2`.
- [ ] `DEPLOYMENT.md` distinguishes Rybbit acknowledgement from stored visibility and retains exactly-one-event visibility as a separate completion gate.
- [ ] The focused edge tests, full repository checks, and whitespace validation all pass from the clean implementation worktree.
- [ ] The implementation changes only the three listed files; it does not deploy, send production traffic, modify provider or tracker state, or reuse tuple `.11.2`.

## Validation plan

- Run `pnpm --filter @sebastian-software/version-service-edge test`; all edge-script tests, including the new 200-discard and malformed-response cases, must pass.
- Run `pnpm agent:check`; lint, formatting, type checks, builds, tests, and repository standards must all pass.
- Run `git diff --check`; it must report no whitespace errors.
- Inspect the final diff and confirm that only `packages/edge-script/src/script.mjs`, `packages/edge-script/src/script.test.mjs`, and `DEPLOYMENT.md` changed.
- Do not use a production request as validation for this implementation plan. After the fix is merged and separately deployed, issue #11 requires a separately authorized run with a fresh tuple.

## Assumptions and open points

- Verified baseline: `origin/main` was `1c85c04f79e18f404196a3457eb0c852e0b546de` on 2026-09-04. The primary checkout was dirty and nine commits behind; implementation must not occur there.
- Verified Rybbit baseline: the production instance reported v2.6.0, whose accepted tracking response is exactly `{"success":true}` and whose known discard responses use HTTP 200 with a different body.
- The local-date query is preferred over an undocumented absolute-datetime query for this run because the verified analytics path is known to honor complete `start_date`, `end_date`, and `time_zone` parameters.
- The chosen response-size strategy is a bounded streamed read with a 1 KiB limit; `Content-Length` is not trusted or required.
- Out of scope: a Rybbit upgrade, upstream authentication redesign, new dependencies, a read-API client or verification script, deployment-workflow changes, production deployment, provider configuration, issue updates, client enablement, and completion of issue #11.
- Stop and revise this plan if the production Rybbit version or its response/query contract changes before implementation.

## Plan review

**Result:** Approved

### Summary

| Area            | Critical | Important | Note |
| --------------- | -------: | --------: | ---: |
| Architecture    |        0 |         0 |    0 |
| Security        |        0 |         0 |    0 |
| Data protection |        0 |         0 |    0 |
| Error cases     |        0 |         0 |    0 |
| Testability     |        0 |         0 |    0 |
| Scope           |        0 |         0 |    0 |
| Maintainability |        0 |         0 |    0 |

### Findings

- **Critical · Error cases · Incorporated:** The plan previously fixed a five-minute window before the request and could shorten post-request observation. The corrected sequence fixes only the query date range before the baseline and measures the complete five-minute visibility interval from the actual request instant.
- **Important · Architecture · Incorporated:** The accepted response is now defined as a semantic JSON predicate rather than ambiguous “exact JSON,” including key ownership, array/null rejection, and no dependence on serialized bytes or `Content-Type`.
- **Important · Testability · Incorporated:** The runbook now requires an exact six-property mapping, identical filters, synthetic values, deterministic timezone conversion, independent status/body capture, and no reuse of `.11.2`.
- **Important · Security · Incorporated:** The selected 1 KiB streamed read bounds memory use without trusting or requiring `Content-Length`; overflow and read failures are explicit fail-closed test cases.

## Open points

- No open points.
