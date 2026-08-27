// Shared update-check endpoint for Sebastian Software CLIs.
//
// Wire contract v2 (see the repository README): clients POST exactly six
// fields — project, version, os, arch, ci, installedSince — and receive
// `{ "latestVersion": "…" }`. The request is counted as one aggregate event;
// there is deliberately no stable identifier. The path, Content-Type, and
// Content-Length are protocol checks only. No client IP, forwarded metadata,
// user agent, identifying header, or generated ID reaches the analytics sink
// or application logs: events are forwarded with neutralized transport
// identity, and the sink only ever sees this script's request, not the
// client's.

const REQUEST_BODY_LIMIT = 1024;
const UPSTREAM_TIMEOUT_MS = 1500;
const VERSION_TTL_MS = 10 * 60 * 1000;
const OLDEST_COHORT = "2020-01";
// Standard semver shape; isVersion caps inputs at 128 characters before
// testing, so worst-case backtracking stays bounded.
const VERSION_PATTERN =
  // eslint-disable-next-line security/detect-unsafe-regex
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const TOKEN_PATTERN = /^[a-z0-9_][a-z0-9_.-]{0,63}$/u;
const COHORT_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const PAYLOAD_KEYS = ["arch", "ci", "installedSince", "os", "project", "version"];

// Per-project allowlist: wire identifier → npm package that carries the
// released version. Adding a CLI to the endpoint is one line here plus the
// client-side wiring in its own repository.
const PROJECTS = {
  palamedes: { npmPackage: "@palamedes/cli" },
};

export function createHandler(configuration, fetchImplementation = fetch, now = Date.now) {
  const state = { configuration, fetchImplementation, now, versionCache: new Map() };
  return async (request) => handle(state, request);
}

async function handle(state, request) {
  const protocolError = validateProtocol(request);
  if (protocolError) return protocolError;
  if (!isConfigured(state.configuration)) {
    return response(503, { error: "service_unconfigured" });
  }

  const payload = await readPayload(request);
  if (!isPayload(payload, state.now)) return response(400, { error: "invalid_request" });

  const version = await latestVersion(state, payload.project);
  if (version === null) return response(503, { error: "latest_version_unavailable" });

  if (!(await countRequest(state, payload))) {
    return response(503, { error: "analytics_unavailable" });
  }

  return response(200, { latestVersion: version });
}

function validateProtocol(request) {
  const url = new URL(request.url);
  if (url.pathname !== "/check") return response(404, { error: "not_found" });
  if (request.method !== "POST") {
    return response(405, { error: "method_not_allowed" }, { Allow: "POST" });
  }
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    return response(415, { error: "unsupported_media_type" });
  }
  return null;
}

function isConfigured(configuration) {
  return Boolean(
    configuration.rybbitEndpoint && configuration.rybbitApiKey && configuration.rybbitSiteId,
  );
}

async function latestVersion(state, project) {
  const cached = state.versionCache.get(project);
  if (cached && cached.expiresAtMs > state.now()) return cached.version;

  const packagePath = PROJECTS[project].npmPackage.replace("/", "%2F");
  let version;
  try {
    const registryResponse = await state.fetchImplementation(
      `https://registry.npmjs.org/${packagePath}/latest`,
      { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) },
    );
    if (!registryResponse.ok) return null;
    const data = await registryResponse.json();
    version = data.version;
  } catch {
    return null;
  }
  if (!isVersion(version)) return null;

  state.versionCache.set(project, { version, expiresAtMs: state.now() + VERSION_TTL_MS });
  return version;
}

async function countRequest(state, payload) {
  const endpoint = `${state.configuration.rybbitEndpoint.replace(/\/$/u, "")}/api/track`;
  try {
    const sinkResponse = await state.fetchImplementation(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.configuration.rybbitApiKey}`,
      },
      body: JSON.stringify({
        site_id: state.configuration.rybbitSiteId,
        type: "custom_event",
        event_name: "update_check",
        // Server-side forward: the sink must never see client transport
        // identity, so both override fields are pinned to neutral values.
        ip_address: "127.0.0.1",
        user_agent: "version-service",
        properties: JSON.stringify({
          project: payload.project,
          version: payload.version,
          os: payload.os,
          arch: payload.arch,
          mode: payload.ci ? "ci" : "local",
          installedSince: payload.installedSince,
        }),
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return sinkResponse.ok;
  } catch {
    return false;
  }
}

async function readPayload(request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > REQUEST_BODY_LIMIT) return null;
  if (!request.body) return null;

  const bytes = await readLimitedBody(request.body.getReader());
  if (bytes === null) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

async function readLimitedBody(reader) {
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > REQUEST_BODY_LIMIT) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return concatenate(chunks, length);
}

function concatenate(chunks, length) {
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function isPayload(value, now) {
  return (
    hasContractShape(value) &&
    hasValidPlatform(value) &&
    isVersion(value.version) &&
    typeof value.ci === "boolean" &&
    isCohort(value.installedSince, now)
  );
}

function hasContractShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.length === PAYLOAD_KEYS.length &&
    keys.every((key, index) => key === PAYLOAD_KEYS[index]) &&
    typeof value.project === "string" &&
    Object.hasOwn(PROJECTS, value.project)
  );
}

function hasValidPlatform(value) {
  return (
    typeof value.os === "string" &&
    TOKEN_PATTERN.test(value.os) &&
    typeof value.arch === "string" &&
    TOKEN_PATTERN.test(value.arch)
  );
}

// Year-month only, never finer: a finer value combined with the other
// dimensions could form linkable singleton cells. Bounded to [2020-01, next
// month] so clock skew at a month boundary does not reject honest clients.
function isCohort(value, now) {
  if (typeof value !== "string" || !COHORT_PATTERN.test(value)) return false;
  const today = new Date(now());
  const nextMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1));
  const upperBound = `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, "0")}`;
  return value >= OLDEST_COHORT && value <= upperBound;
}

function isVersion(value) {
  if (typeof value !== "string" || value.length > 128 || !VERSION_PATTERN.test(value)) {
    return false;
  }
  const withoutBuild = value.split("+", 1)[0];
  const separator = withoutBuild.indexOf("-");
  if (separator === -1) return true;
  return withoutBuild
    .slice(separator + 1)
    .split(".")
    .every(
      (identifier) =>
        !/^\d+$/u.test(identifier) || identifier === "0" || !identifier.startsWith("0"),
    );
}

function response(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

// Bunny Edge Scripting bootstrap. Node's test runner imports this module with
// no Deno global, so tests exercise createHandler without starting a server.
if (globalThis.Deno !== undefined) {
  const BunnySDK = await import("https://esm.sh/@bunny.net/edgescript-sdk@0.11");
  BunnySDK.net.http.serve(
    createHandler({
      rybbitEndpoint: globalThis.Deno.env.get("RYBBIT_ENDPOINT"),
      rybbitApiKey: globalThis.Deno.env.get("RYBBIT_API_KEY"),
      rybbitSiteId: globalThis.Deno.env.get("RYBBIT_SITE_ID"),
    }),
  );
}
