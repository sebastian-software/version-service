import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import { createHandler } from "./script.mjs";

const NOW_MS = Date.UTC(2026, 7, 27);
const TEN_MINUTES_MS = 10 * 60 * 1000;
const CONFIGURATION = {
  rybbitEndpoint: "https://analytics.example",
  rybbitApiKey: "test-key",
  rybbitSiteId: "42",
};

function payload(overrides = {}) {
  return {
    project: "palamedes",
    version: "1.17.3",
    os: "linux",
    arch: "x86_64",
    ci: false,
    installedSince: "2026-08",
    ...overrides,
  };
}

function checkRequest(body, headers = { "content-type": "application/json" }) {
  return new Request("https://version-service.sebastian-software.de/check", {
    method: "POST",
    headers,
    body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
  });
}

function deferredFetch(analytics = () => Response.json({ success: true })) {
  const registryCalls = [];
  const analyticsCalls = [];
  const implementation = (url, options = {}) => {
    const call = { url: String(url), options };
    if (call.url.startsWith("https://registry.npmjs.org/")) {
      const pending = Promise.withResolvers();
      registryCalls.push({ ...call, ...pending });
      return pending.promise;
    }
    analyticsCalls.push(call);
    return analytics(call);
  };
  return { registryCalls, analyticsCalls, implementation };
}

async function startBurst(handle, bodies = [payload(), payload(), payload()]) {
  const results = bodies.map((body) => handle(checkRequest(body)));
  // Drain request-stream reads and their promise continuations before inspecting
  // upstream calls. Registry responses stay explicitly pending across this turn.
  await setImmediate();
  return results;
}

test("shares one cold-cache refresh across three overlapping requests", async () => {
  const { registryCalls, analyticsCalls, implementation } = deferredFetch();
  const handle = createHandler(CONFIGURATION, implementation, () => NOW_MS);

  const pending = await startBurst(handle);
  const lookupCount = registryCalls.length;
  for (const call of registryCalls) call.resolve(Response.json({ version: "1.18.0" }));
  const results = await Promise.all(pending);

  assert.equal(lookupCount, 1);
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { latestVersion: "1.18.0" });
  }
  assert.equal(analyticsCalls.length, 3);
});

async function assertVersionResults(pending, latestVersion) {
  for (const result of await Promise.all(pending)) {
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { latestVersion });
  }
}

async function assertUnavailableResults(pending) {
  for (const result of await Promise.all(pending)) {
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { error: "latest_version_unavailable" });
  }
}

async function completeRefresh(handle, registryCalls, { lookupCount, version, bodies }) {
  const pending = await startBurst(handle, bodies);
  assert.equal(registryCalls.length, lookupCount);
  registryCalls.at(-1).resolve(Response.json({ version }));
  await assertVersionResults(pending, version);
}

test("uses the cache just before expiry and shares a refresh at exact expiry", async () => {
  let nowMs = NOW_MS;
  const { registryCalls, implementation } = deferredFetch();
  const handle = createHandler(CONFIGURATION, implementation, () => nowMs);
  const first = await startBurst(handle, [payload()]);
  registryCalls[0].resolve(Response.json({ version: "1.18.0" }));
  await assertVersionResults(first, "1.18.0");

  nowMs += TEN_MINUTES_MS - 1;
  await assertVersionResults([handle(checkRequest(payload()))], "1.18.0");
  assert.equal(registryCalls.length, 1);

  nowMs += 1;
  const expired = await startBurst(handle);
  assert.equal(registryCalls.length, 2);
  registryCalls[1].resolve(Response.json({ version: "1.19.0" }));
  await assertVersionResults(expired, "1.19.0");
});

test("starts the cache TTL when a delayed refresh successfully completes", async () => {
  let nowMs = NOW_MS;
  const { registryCalls, implementation } = deferredFetch();
  const handle = createHandler(CONFIGURATION, implementation, () => nowMs);
  const pending = await startBurst(handle);

  nowMs += TEN_MINUTES_MS;
  registryCalls[0].resolve(Response.json({ version: "1.18.0" }));
  await assertVersionResults(pending, "1.18.0");

  nowMs += TEN_MINUTES_MS - 1;
  await assertVersionResults([handle(checkRequest(payload()))], "1.18.0");
  assert.equal(registryCalls.length, 1);
});

test("shares registry failures without counting and allows immediate retry", async () => {
  const failures = [
    ["non-success HTTP status", (call) => call.resolve(new Response(null, { status: 500 }))],
    ["rejected fetch", (call) => call.reject(new TypeError("fetch failed"))],
    [
      "timeout-shaped rejection",
      (call) => call.reject(new DOMException("upstream timed out", "TimeoutError")),
    ],
    ["invalid JSON", (call) => call.resolve(new Response("not json"))],
    ["invalid version", (call) => call.resolve(Response.json({ version: "01.2.3" }))],
  ];

  for (const [name, fail] of failures) {
    const { registryCalls, analyticsCalls, implementation } = deferredFetch();
    const handle = createHandler(CONFIGURATION, implementation, () => NOW_MS);
    const pending = await startBurst(handle);
    assert.equal(registryCalls.length, 1, name);
    assert.equal(analyticsCalls.length, 0, name);

    fail(registryCalls[0]);
    await assertUnavailableResults(pending);
    assert.equal(analyticsCalls.length, 0, name);

    await completeRefresh(handle, registryCalls, {
      lookupCount: 2,
      version: "1.19.0",
      bodies: [payload()],
    });
    assert.equal(analyticsCalls.length, 1, name);
  }
});

test("clears a refresh after a synchronous fetch exception", async () => {
  const { registryCalls, analyticsCalls, implementation } = deferredFetch();
  let fail = true;
  const handle = createHandler(
    CONFIGURATION,
    (url, options) => {
      if (fail) throw new TypeError("fetch failed synchronously");
      return implementation(url, options);
    },
    () => NOW_MS,
  );

  await assertUnavailableResults([handle(checkRequest(payload()))]);
  assert.equal(registryCalls.length, 0);
  assert.equal(analyticsCalls.length, 0);
  fail = false;
  await completeRefresh(handle, registryCalls, {
    lookupCount: 1,
    version: "1.18.0",
    bodies: [payload()],
  });
  assert.equal(analyticsCalls.length, 1);
});

test("never serves an expired version after failure and caches a successful retry", async () => {
  let nowMs = NOW_MS;
  const { registryCalls, analyticsCalls, implementation } = deferredFetch();
  const handle = createHandler(CONFIGURATION, implementation, () => nowMs);
  await completeRefresh(handle, registryCalls, {
    lookupCount: 1,
    version: "1.18.0",
    bodies: [payload()],
  });

  nowMs += TEN_MINUTES_MS;
  const expired = await startBurst(handle);
  assert.equal(registryCalls.length, 2);
  registryCalls[1].resolve(new Response(null, { status: 500 }));
  await assertUnavailableResults(expired);
  assert.equal(analyticsCalls.length, 1);

  await completeRefresh(handle, registryCalls, { lookupCount: 3, version: "1.19.0" });
  await assertVersionResults([handle(checkRequest(payload()))], "1.19.0");
  assert.equal(registryCalls.length, 3);
  assert.equal(analyticsCalls.length, 5);
});

function deferredAnalyticsFetch() {
  const acknowledgements = [];
  const fetchStub = deferredFetch(() => {
    if (acknowledgements.length >= 4) return Response.json({ success: true });
    const pending = Promise.withResolvers();
    acknowledgements.push(pending);
    return pending.promise;
  });
  return { ...fetchStub, acknowledgements };
}

async function assertIndependentAnalytics(handle, { analyticsCalls, acknowledgements }, bodies) {
  const arrivingBody = payload({ version: "1.17.6" });
  const arriving = await startBurst(handle, [arrivingBody]);
  assert.equal(analyticsCalls.length, 4);
  for (const [index, body] of [...bodies, arrivingBody].entries()) {
    assertNeutralizedEvent(analyticsCalls[index], body);
  }

  // Complete the new cache hit before the original requests' analytics settle.
  acknowledgements[3].resolve(Response.json({ success: true }));
  await assertVersionResults(arriving, "1.18.0");
  acknowledgements[0].resolve(Response.json({ success: true }));
  acknowledgements[1].resolve(new Response(null, { status: 429 }));
  acknowledgements[2].resolve(Response.json({ success: true }));
}

test("keeps each analytics attempt independent of the shared refresh and its peers", async () => {
  const { registryCalls, analyticsCalls, implementation, acknowledgements } =
    deferredAnalyticsFetch();
  const handle = createHandler(CONFIGURATION, implementation, () => NOW_MS);
  const bodies = [
    payload(),
    payload({ version: "1.17.4", os: "darwin", arch: "arm64", ci: true }),
    payload({ version: "1.17.5", os: "win32", installedSince: "2026-07" }),
  ];
  const pending = await startBurst(handle, bodies);
  assert.equal(registryCalls.length, 1);
  registryCalls[0].resolve(Response.json({ version: "1.18.0" }));
  await setImmediate();
  await assertIndependentAnalytics(handle, { analyticsCalls, acknowledgements }, bodies);
  const results = await Promise.all(pending);
  await assertVersionResults([results[0], results[2]], "1.18.0");
  assert.equal(results[1].status, 503);
  assert.deepEqual(await results[1].json(), { error: "analytics_unavailable" });

  await assertVersionResults([handle(checkRequest(payload()))], "1.18.0");
  assert.equal(registryCalls.length, 1);
  assert.equal(analyticsCalls.length, 5);
});

test("isolates pending refreshes and cached versions between handler instances", async () => {
  const { registryCalls, implementation } = deferredFetch();
  const first = createHandler(CONFIGURATION, implementation, () => NOW_MS);
  const second = createHandler(CONFIGURATION, implementation, () => NOW_MS);
  const firstPending = await startBurst(first);
  const secondPending = await startBurst(second);
  assert.equal(registryCalls.length, 2);

  registryCalls[1].resolve(Response.json({ version: "2.0.0" }));
  await assertVersionResults(secondPending, "2.0.0");
  await assertVersionResults([second(checkRequest(payload()))], "2.0.0");
  registryCalls[0].resolve(Response.json({ version: "1.18.0" }));
  await assertVersionResults(firstPending, "1.18.0");
  await assertVersionResults([first(checkRequest(payload()))], "1.18.0");
  assert.equal(registryCalls.length, 2);
});

function assertNeutralizedEvent(call, expected = payload()) {
  assert.equal(call.url, "https://analytics.example/api/track");
  assert.equal(call.options.headers.Authorization, "Bearer test-key");
  const event = JSON.parse(call.options.body);
  assert.equal(event.site_id, "42");
  assert.equal(event.type, "custom_event");
  assert.equal(event.event_name, "update_check");
  assert.equal(event.ip_address, "127.0.0.1");
  assert.equal(event.user_agent, "version-service");
  assert.deepEqual(JSON.parse(event.properties), {
    project: expected.project,
    version: expected.version,
    os: expected.os,
    arch: expected.arch,
    mode: expected.ci ? "ci" : "local",
    installedSince: expected.installedSince,
  });
}
