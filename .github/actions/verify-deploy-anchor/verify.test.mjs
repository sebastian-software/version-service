/* eslint-disable security/detect-non-literal-fs-filename -- Every dynamic path is confined to a test-owned temporary directory. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const actionDirectory = import.meta.dirname;
const verifyScript = join(actionDirectory, "verify.sh");

function run(command, arguments_, { cwd, env = {} } = {}) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      LANG: "C",
      LC_ALL: "C",
      ...env,
    },
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function git(cwd, ...arguments_) {
  const result = run("git", arguments_, { cwd });
  assert.equal(
    result.status,
    0,
    `git ${arguments_.join(" ")} failed:\n${result.stdout}${result.stderr}`,
  );
  return result.stdout.trim();
}

async function initializeRemote(root, remote, publisher) {
  git(root, "init", "--bare", remote);
  git(root, "init", publisher);
  git(publisher, "config", "user.name", "Version Service Test");
  git(publisher, "config", "user.email", "version-service-test@example.invalid");
  git(publisher, "config", "commit.gpgSign", "false");
  git(publisher, "config", "tag.gpgSign", "false");
  git(publisher, "config", "core.hooksPath", "/dev/null");
  await writeFile(join(publisher, "script.mjs"), "export default 'first';\n");
  git(publisher, "add", "script.mjs");
  git(publisher, "commit", "-m", "initial deployment revision");
  git(publisher, "branch", "-M", "main");
  git(publisher, "remote", "add", "origin", remote);
  git(publisher, "push", "-u", "origin", "main");
}

async function createGitFixture() {
  const root = await mkdtemp(join(tmpdir(), "version-service-deploy-anchor-"));
  const remote = join(root, "origin.git");
  const publisher = join(root, "publisher");
  const checkout = join(root, "checkout");
  const output = join(root, "github-output");

  await initializeRemote(root, remote, publisher);
  git(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "clone", remote, checkout);

  return {
    root,
    remote,
    publisher,
    checkout,
    output,
    anchor: git(checkout, "rev-parse", "HEAD"),
  };
}

async function runVerification(fixture, anchor) {
  await writeFile(fixture.output, "");
  const result = run("bash", [verifyScript], {
    cwd: fixture.checkout,
    env: {
      EXPECTED_ANCHOR: anchor,
      GITHUB_OUTPUT: fixture.output,
    },
  });
  return {
    ...result,
    outputs: await readFile(fixture.output, "utf8"),
  };
}

function outputValues(outputs) {
  return Object.fromEntries(
    outputs
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(/=(.*)/su).slice(0, 2)),
  );
}

test("accepts an immutable anchor that is still current main", async () => {
  const fixture = await createGitFixture();
  try {
    const result = await runVerification(fixture, fixture.anchor);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Deployment anchor is still current main\./u);
    assert.deepEqual(outputValues(result.outputs), {
      eligible: "true",
      current: fixture.anchor,
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects an anchor when remote main advances while a run is queued", async () => {
  const fixture = await createGitFixture();
  try {
    await writeFile(join(fixture.publisher, "script.mjs"), "export default 'second';\n");
    git(fixture.publisher, "add", "script.mjs");
    git(fixture.publisher, "commit", "-m", "advance main");
    git(fixture.publisher, "push", "origin", "main");
    const current = git(fixture.publisher, "rev-parse", "HEAD");

    const result = await runVerification(fixture, fixture.anchor);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /deployment anchor is stale/u);
    assert.deepEqual(outputValues(result.outputs), {
      eligible: "false",
      current,
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects malformed anchors without ever reporting eligibility", async () => {
  const fixture = await createGitFixture();
  try {
    const result = await runVerification(fixture, "deadbeef");
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /must be a lowercase full commit SHA/u);
    assert.match(result.outputs, /^eligible=false$/mu);
    assert.doesNotMatch(result.outputs, /^eligible=true$/mu);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fails closed when current main cannot be fetched", async () => {
  const fixture = await createGitFixture();
  try {
    git(fixture.checkout, "remote", "set-url", "origin", join(fixture.root, "missing.git"));

    const result = await runVerification(fixture, fixture.anchor);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Could not fetch current main/u);
    assert.match(result.outputs, /^eligible=false$/mu);
    assert.doesNotMatch(result.outputs, /^eligible=true$/mu);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
