/* eslint-disable security/detect-non-literal-fs-filename -- Every dynamic path is confined to a test-owned temporary directory. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const targetName = ".env.bunny-deploy.local";
const preparationScript = join(import.meta.dirname, "prepare-bunny-deploy-key.sh");

async function createFixture(contents) {
  const root = await mkdtemp(join(tmpdir(), "version-service-bunny-key-"));
  const target = join(root, targetName);
  const output = join(root, "github-output");
  await writeFile(target, contents, { mode: 0o644 });
  await writeFile(output, "");
  return { root, target, output };
}

async function runPreparation(fixture, decryptedFiles = targetName) {
  const result = spawnSync("bash", [preparationScript], {
    cwd: fixture.root,
    encoding: "utf8",
    env: {
      ...process.env,
      DECRYPTED_FILES: decryptedFiles,
      GITHUB_OUTPUT: fixture.output,
      LANG: "C",
      LC_ALL: "C",
    },
  });
  if (result.error) {
    throw result.error;
  }
  return {
    ...result,
    outputs: await readFile(fixture.output, "utf8"),
  };
}

async function cleanFixture(fixture) {
  await rm(fixture.root, { recursive: true, force: true });
}

test("masks workflow-command sequences while preserving the exact deployment key", async () => {
  const deployKey = "fake=segment%0Apercent%25tail";
  const fixture = await createFixture(`BUNNY_DEPLOY_KEY=${deployKey}\n`);
  try {
    const result = await runPreparation(fixture);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.outputs, `deploy_key=${deployKey}\n`);
    assert.equal(result.stdout, "::add-mask::fake=segment%250Apercent%2525tail\n");
    assert.equal(result.stdout.includes(deployKey), false);
    const targetStats = await stat(fixture.target);
    assert.equal(targetStats.mode & 0o777, 0o600);
  } finally {
    await cleanFixture(fixture);
  }
});

test("rejects deployment keys with boundary whitespace", async () => {
  for (const value of ["   ", " leading", "trailing "]) {
    const fixture = await createFixture(`BUNNY_DEPLOY_KEY=${value}\n`);
    try {
      const result = await runPreparation(fixture);
      assert.notEqual(result.status, 0, `accepted ${JSON.stringify(value)}`);
      assert.equal(result.outputs.includes("deploy_key="), false);
    } finally {
      await cleanFixture(fixture);
    }
  }
});

test("rejects duplicate deployment keys without writing an output", async () => {
  const fixture = await createFixture("BUNNY_DEPLOY_KEY=first\nBUNNY_DEPLOY_KEY=second\n");
  try {
    const result = await runPreparation(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /must occur exactly once/u);
    assert.equal(result.outputs.includes("deploy_key="), false);
  } finally {
    await cleanFixture(fixture);
  }
});

test("requires Limen to report exactly the intended decrypted path", async () => {
  const fixture = await createFixture("BUNNY_DEPLOY_KEY=fake-key\n");
  try {
    const result = await runPreparation(fixture, "different.env");
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /exactly the intended Bunny dotenv target/u);
    assert.equal(result.outputs.includes("deploy_key="), false);
  } finally {
    await cleanFixture(fixture);
  }
});
