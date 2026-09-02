/* eslint-disable security/detect-non-literal-fs-filename -- Every dynamic path is confined to a test-owned temporary directory. */
/* cspell:ignore pipefail esac */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const probeScript = join(import.meta.dirname, "probe-production-contract.sh");

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function createFixture(responses) {
  const root = await mkdtemp(join(tmpdir(), "version-service-production-probe-"));
  const bin = join(root, "bin");
  await mkdir(bin);

  await writeFile(
    join(bin, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
output=""
while (($#)); do
  case "$1" in
    --output)
      output="$2"
      shift 2
      ;;
    --write-out)
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
count_file="$PROBE_FIXTURE_ROOT/curl-count"
count=0
if [[ -f "$count_file" ]]; then
  count="$(cat "$count_file")"
fi
count=$((count + 1))
printf '%s' "$count" > "$count_file"
cat "$PROBE_FIXTURE_ROOT/body-$count" > "$output"
cat "$PROBE_FIXTURE_ROOT/status-$count"
exit "$(cat "$PROBE_FIXTURE_ROOT/exit-$count")"
`,
    { mode: 0o755 },
  );

  await writeFile(
    join(bin, "sleep"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" >> "$PROBE_FIXTURE_ROOT/sleep-log"
`,
    { mode: 0o755 },
  );

  await Promise.all(
    responses.flatMap((response, index) => {
      const attempt = index + 1;
      return [
        writeFile(join(root, `status-${attempt}`), response.status ?? "000"),
        writeFile(join(root, `body-${attempt}`), response.body ?? ""),
        writeFile(join(root, `exit-${attempt}`), String(response.exitCode ?? 0)),
      ];
    }),
  );

  return { bin, root };
}

function runProbe(fixture, maxAttempts) {
  const result = spawnSync("bash", [probeScript, "https://version-service.example/check"], {
    encoding: "utf8",
    env: {
      ...process.env,
      LANG: "C",
      LC_ALL: "C",
      PATH: `${fixture.bin}:${process.env.PATH}`,
      PROBE_FIXTURE_ROOT: fixture.root,
      PROBE_MAX_ATTEMPTS: String(maxAttempts),
      PROBE_RETRY_DELAY_SECONDS: "10",
    },
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

async function cleanFixture(fixture) {
  await rm(fixture.root, { recursive: true, force: true });
}

test("retries propagation mismatches until the exact contract is available", async () => {
  const fixture = await createFixture([
    { status: "503", body: '{"error":"configuration_error"}' },
    { status: "400", body: '{"error":"invalid_request"}\n' },
    { status: "400", body: '{"error":"invalid_request"}' },
  ]);
  try {
    const result = runProbe(fixture, 4);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /succeeded on attempt 3 of 4/u);
    assert.equal(await readFile(join(fixture.root, "curl-count"), "utf8"), "3");
    assert.equal(await readFile(join(fixture.root, "sleep-log"), "utf8"), "10\n10\n");
    assert.equal((result.stdout + result.stderr).includes("configuration_error"), false);
  } finally {
    await cleanFixture(fixture);
  }
});

test("retries a transport failure without weakening the response contract", async () => {
  const fixture = await createFixture([
    { status: "000", exitCode: 7 },
    { status: "400", body: '{"error":"invalid_request"}' },
  ]);
  try {
    const result = runProbe(fixture, 2);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /succeeded on attempt 2 of 2/u);
    assert.equal(await readFile(join(fixture.root, "curl-count"), "utf8"), "2");
    assert.equal(await readFile(join(fixture.root, "sleep-log"), "utf8"), "10\n");
  } finally {
    await cleanFixture(fixture);
  }
});

test("fails closed after the configured attempt bound", async () => {
  const fixture = await createFixture([
    { status: "503", body: "not ready" },
    { status: "502", body: "still not ready" },
    { status: "400", body: '{"error":"wrong"}' },
  ]);
  try {
    const result = runProbe(fixture, 3);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /after 3 attempts/u);
    assert.equal(await readFile(join(fixture.root, "curl-count"), "utf8"), "3");
    assert.equal(await readFile(join(fixture.root, "sleep-log"), "utf8"), "10\n10\n");
    assert.equal((result.stdout + result.stderr).includes("still not ready"), false);
  } finally {
    await cleanFixture(fixture);
  }
});

test("rejects invalid retry configuration before making a request", async () => {
  const fixture = await createFixture([]);
  try {
    const result = runProbe(fixture, 0);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /PROBE_MAX_ATTEMPTS must be a positive integer/u);
    assert.equal(await readOptional(join(fixture.root, "curl-count")), "");
  } finally {
    await cleanFixture(fixture);
  }
});
