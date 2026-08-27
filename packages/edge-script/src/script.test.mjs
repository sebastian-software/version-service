import assert from "node:assert/strict";
import test from "node:test";

import { createHandler } from "./script.mjs";

const NOW_MS = Date.UTC(2026, 7, 27);
const REQUEST_BODY_OVERFLOW = 1100;
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
  return new Request("https://version.sebastian-software.dev/check", {
    method: "POST",
    headers,
    body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
  });
}

function stubFetch({ npmVersion = "1.18.0", npmStatus = 200, rybbitStatus = 200 } = {}) {
  const calls = [];
  const implementation = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).startsWith("https://registry.npmjs.org/")) {
      return new Response(JSON.stringify({ version: npmVersion }), { status: npmStatus });
    }
    return new Response("{}", { status: rybbitStatus });
  };
  return { calls, implementation };
}

test("enforces route, method, and media type before any upstream work", async () => {
  const { calls, implementation } = stubFetch();
  const handle = createHandler(CONFIGURATION, implementation, () => NOW_MS);

  const notFound = await handle(
    new Request("https://version.sebastian-software.dev/other", { method: "POST" }),
  );
  assert.equal(notFound.status, 404);

  const wrongMethod = await handle(
    new Request("https://version.sebastian-software.dev/check", { method: "GET" }),
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");

  const wrongMedia = await handle(checkRequest(payload(), { "content-type": "text/plain" }));
  assert.equal(wrongMedia.status, 415);

  assert.equal(calls.length, 0);
});

function assertNeutralizedEvent(call) {
  assert.equal(call.url, "https://analytics.example/api/track");
  assert.equal(call.options.headers.Authorization, "Bearer test-key");
  const event = JSON.parse(call.options.body);
  assert.equal(event.site_id, "42");
  assert.equal(event.type, "custom_event");
  assert.equal(event.event_name, "update_check");
  assert.equal(event.ip_address, "127.0.0.1");
  assert.equal(event.user_agent, "version-service");
  assert.deepEqual(JSON.parse(event.properties), {
    project: "palamedes",
    version: "1.17.3",
    os: "linux",
    arch: "x86_64",
    mode: "local",
    installedSince: "2026-08",
  });
}

test("answers a valid check and forwards one neutralized aggregate event", async () => {
  const { calls, implementation } = stubFetch();
  const handle = createHandler(CONFIGURATION, implementation, () => NOW_MS);

  const result = await handle(
    checkRequest(payload(), { "content-type": "Application/JSON; charset=utf-8" }),
  );

  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(await result.json(), { latestVersion: "1.18.0" });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://registry.npmjs.org/@palamedes%2Fcli/latest");
  assertNeutralizedEvent(calls[1]);
});

test("rejects invalid payloads without writing analytics", async () => {
  const invalidBodies = [
    payload({ extra: "field" }),
    { ...payload(), installedSince: undefined },
    payload({ project: "unknown" }),
    payload({ version: "01.2.3" }),
    payload({ version: "1.2.3-01" }),
    payload({ os: "Linux OS" }),
    payload({ arch: "" }),
    payload({ ci: "true" }),
    payload({ installedSince: "2026-08-27" }),
    payload({ installedSince: "2026-13" }),
    payload({ installedSince: "2019-12" }),
    payload({ installedSince: "2026-10" }),
    [payload()],
    "not json {",
    new Uint8Array([0xff, 0xfe, 0x7b, 0x7d]),
    `{"filler": "${"x".repeat(REQUEST_BODY_OVERFLOW)}"}`,
  ];

  for (const body of invalidBodies) {
    const { calls, implementation } = stubFetch();
    const handle = createHandler(CONFIGURATION, implementation, () => NOW_MS);
    const result = await handle(checkRequest(body));
    assert.equal(result.status, 400, `accepted ${JSON.stringify(body).slice(0, 60)}`);
    assert.equal(calls.length, 0);
  }
});

test("accepts the documented cohort bounds including next-month clock skew", async () => {
  for (const installedSince of ["2020-01", "2026-08", "2026-09"]) {
    const { implementation } = stubFetch();
    const handle = createHandler(CONFIGURATION, implementation, () => NOW_MS);
    const result = await handle(checkRequest(payload({ installedSince })));
    assert.equal(result.status, 200, `rejected ${installedSince}`);
  }
});

test("fails closed when deployment configuration is missing", async () => {
  const { calls, implementation } = stubFetch();
  const handle = createHandler({}, implementation, () => NOW_MS);

  const result = await handle(checkRequest(payload()));

  assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), { error: "service_unconfigured" });
  assert.equal(calls.length, 0);
});

test("does not count a request it cannot answer", async () => {
  const { calls, implementation } = stubFetch({ npmStatus: 500 });
  const handle = createHandler(CONFIGURATION, implementation, () => NOW_MS);

  const result = await handle(checkRequest(payload()));

  assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), { error: "latest_version_unavailable" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /registry\.npmjs\.org/u);
});

test("does not answer a request it cannot count", async () => {
  const { implementation } = stubFetch({ rybbitStatus: 429 });
  const handle = createHandler(CONFIGURATION, implementation, () => NOW_MS);

  const result = await handle(checkRequest(payload()));

  assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), { error: "analytics_unavailable" });
});

test("caches the released version and refreshes it after the TTL", async () => {
  let nowMs = NOW_MS;
  const { calls, implementation } = stubFetch();
  const handle = createHandler(CONFIGURATION, implementation, () => nowMs);
  const npmCalls = () => calls.filter((call) => call.url.includes("registry.npmjs.org")).length;

  const first = await handle(checkRequest(payload()));
  const second = await handle(checkRequest(payload()));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(npmCalls(), 1);

  nowMs += 11 * 60 * 1000;
  const third = await handle(checkRequest(payload()));
  assert.equal(third.status, 200);
  assert.equal(npmCalls(), 2);
});
