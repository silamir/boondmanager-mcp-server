---
paths:
  - "src/transports/**/*.ts"
  - "src/services/oauth.ts"
  - "src/services/http/auth.ts"
  - "src/index.ts"
  - "Dockerfile"
  - "README-docker.md"
  - "docs/oauth.md"
---

# Transports (stdio / Streamable HTTP) and authentication

<!-- Moved verbatim from CLAUDE.md; loaded only when Claude works on the files above. -->

## Transports

The server selects its transport from `MCP_TRANSPORT`:

- **`stdio`** (default): wraps `StdioServerTransport`, used by Claude Desktop / Claude Code locally. Auth: JWT (X-Jwt-Client-Boondmanager) or BasicAuth via env vars.
- **`http`** (alias: `streamable-http`): starts a Node HTTP server using `StreamableHTTPServerTransport` from the MCP SDK. Intended for MCP gateways and remote deployments. **Auth: OAuth2 protected resource** — the server holds no tokens; each MCP request must carry `Authorization: Bearer <boond_access_token>` and is forwarded verbatim to BoondManager. See the *Authentication → http transport* section below.

HTTP env vars (see `src/transports/http.ts::resolveHttpOptions`):

| Var | Default | Purpose |
|-----|---------|---------|
| `MCP_HTTP_HOST` | `127.0.0.1` | Listen interface (Docker image overrides to `0.0.0.0`) |
| `MCP_HTTP_PORT` | `3000` | TCP port |
| `MCP_HTTP_PATH` | `/mcp` | Endpoint path |
| `MCP_HTTP_STATEFUL` | `false` | `true` to enable session mode (`Mcp-Session-Id`) |
| `MCP_HTTP_JSON_RESPONSE` | `false` | `true` to return JSON instead of SSE streams. **Known limitation**: with no response stream there is nowhere to deliver `notifications/progress`, so progress notifications are silently dropped (see *Progress Notifications*). Tool results are unaffected. |
| `MCP_HTTP_PUBLIC_URL` | (derived) | Public URL advertised in the OAuth2 discovery metadata. Required behind a reverse proxy. |
| `MCP_HTTP_SESSION_TTL_MS` | `1800000` (30 min) | Stateful only: idle window before a session is closed |
| `MCP_HTTP_SESSION_SWEEP_INTERVAL_MS` | `300000` (5 min) | Stateful only: how often to scan for idle sessions |
| `MCP_HTTP_MAX_SESSIONS` | `1000` | Stateful only: max concurrent sessions. New `initialize` requests beyond the cap get `503` (after an idle sweep). Guards against memory exhaustion via unbounded session creation. |
| `MCP_HTTP_KEEP_ALIVE_TIMEOUT_MS` | `65000` | Node `server.keepAliveTimeout`. Must exceed the idle timeout of any load balancer in front (60 s AWS ALB, 75 s nginx): Node's 5 s default is below both, so the LB reused a connection Node had just closed and answered intermittent `502`s (issue #237). |
| `MCP_HTTP_HEADERS_TIMEOUT_MS` | `66000` | Node `server.headersTimeout`. Node requires it above the keep-alive timeout; a lower value is raised to keep-alive + 1 s with a warning (`resolveServerTimeouts`). |
| `MCP_HTTP_REQUEST_TIMEOUT_MS` | `300000` | Node `server.requestTimeout` (whole request, headers + body). Generous on purpose: reporting calls are long. |
| `MCP_HTTP_SHUTDOWN_TIMEOUT_MS` | `10000` | Grace period `handle.close()` gives in-flight connections (open SSE stream, request mid-body) before `closeAllConnections()`. Idle keep-alive sockets are closed at once by Node's `close()`. `src/index.ts` adds a forced `process.exit(1)` 2 s after that in case something else wedges. |
| `MCP_HTTP_VALIDATE_TOKEN` | `false` | OAuth mode only (issue #234): validate every Bearer with `GET /application/current-user` **before** dispatching, cached per `sha256(token)` for `MCP_HTTP_TOKEN_VALIDATION_TTL_MS`. A token BoondManager rejects with 401 gets HTTP `401` + `WWW-Authenticate: Bearer realm=…, resource_metadata=…, error="invalid_token"` (RFC 6750) — the signal a spec-compliant client turns into a fresh authorization. Without it the upstream 401 only shows inside a `tools/call` result, which no client re-authorizes from (the SDK turns every handler error into an `isError` result, so a protocol-level `-32001` cannot be raised from a tool). Any other upstream failure (5xx, network) fails **open** and is not cached. Ignored in static-auth mode. |
| `MCP_HTTP_TOKEN_VALIDATION_TTL_MS` | `60000` | Lifetime of a cached token verdict, positive and negative (a client retrying a dead token costs no extra BoondManager call). LRU-bounded at `MAX_TOKEN_VALIDATION_ENTRIES` (500). |
| `MCP_HTTP_ALLOWED_HOSTS` | (auto) | Comma-separated allow-list of `Host` header hostnames for DNS rebinding protection (CVE-2025-66414). Default = `localhost,127.0.0.1,[::1]` when bound to a loopback interface, otherwise validation is disabled. Set to exactly `*` (sole entry) to opt out explicitly when fronting the server with a reverse proxy that already validates hosts; a `*` mixed with real hostnames is ignored (validation stays on) with a warning. |
| `BOOND_HTTP_STATIC_AUTH` | `false` | `true`/`1`/`yes`: use the env credentials (`BOOND_USER_TOKEN`+`BOOND_CLIENT_TOKEN`+`BOOND_CLIENT_KEY`, `BOOND_API_TOKEN` or BasicAuth) for every request instead of a per-request OAuth Bearer. See *Static auth* below — with no `MCP_HTTP_API_KEY` this is an **anonymous proxy** carrying the operator's rights. |
| `MCP_HTTP_API_KEY` | (none) | Static auth only: shared secret the MCP client must present as `Authorization: Bearer <key>` or `X-Api-Key: <key>`. Constant-time comparison; missing/wrong → `401`. **Required** when `BOOND_HTTP_STATIC_AUTH=true` and the bind is not loopback (the server refuses to start otherwise). Blank / unresolved `${…}` = unconfigured. Ignored (with a warning) in OAuth mode. |
| `MCP_HTTP_INSECURE_STATIC_AUTH` | `false` | Explicit opt-out of that start-up refusal, for a deployment whose network is the boundary. Named "insecure" on purpose. |
| `MCP_HTTP_ALLOWED_ORIGINS` | (auto) | Comma-separated allow-list of `Origin` header values (scheme + host + port) accepted from browser-based clients — required by spec 2025-11-25, which mandates a `403` on an invalid `Origin`. Default when bound to a loopback interface = **any loopback origin on any port** (`http`/`https` on `localhost` / `127.0.0.1` / `[::1]`) plus the origin of `MCP_HTTP_PUBLIC_URL` if set; validation is disabled otherwise. Same `*` semantics as `MCP_HTTP_ALLOWED_HOSTS`. **A request with no `Origin` is always accepted** (curl, gateways, non-browser MCP clients never send one). |

`Origin` validation runs right after the `Host` check, in the same block.
`/healthz` is exempt from both, and the RFC 9728 discovery document
(`/.well-known/oauth-protected-resource*`) is exempt from the `Origin` check —
it is public and credential-free, and a browser only fetches it because a `401`
challenge pointed it there, so a `403` would dead-end the OAuth bootstrap.
Entries are compared case-insensitively and ignoring a trailing slash.

**Why the loopback default is port-agnostic** (`resolveOriginPolicy` in
`src/transports/http.ts`): an *explicitly configured* list is exact-match and
therefore port-sensitive, but pinning the bound port in the **default** would
`403` every real browser client. Nothing is ever served *from* the MCP port — it
answers JSON-RPC — so the origins that legitimately appear are other local ports
(MCP Inspector on `:6274`, a dev server on `:5173`) or the reverse proxy's public
URL. The anti-DNS-rebinding property is unaffected: a remote `Origin` still gets
a `403` (matching is on the hostname *literal*, so `http://127.0.0.1.nip.io` is
rejected), and an attacker already executing on the loopback interface can just
omit the header, which is always accepted.

An **empty** `MCP_HTTP_ALLOWED_HOSTS` / `MCP_HTTP_ALLOWED_ORIGINS` (blank value,
or only commas) counts as *unconfigured* and falls back to the default — a blank
env var must never silently switch a security control off. `*` is the explicit
opt-out.

**Static auth** (`BOOND_HTTP_STATIC_AUTH=true`, issue #230): the HTTP transport
runs with the operator's env credentials and the Bearer check is skipped — so
whoever reaches the port acts with the operator's BoondManager rights, read and
write, and off loopback the `Host` / `Origin` validations are off too (the Docker
image binds `0.0.0.0`). Meant for single-tenant self-hosted deployments, CI
pipelines and internal gateways without an OAuth flow, **never** as a public
endpoint. Three guards, each with a test in `http.test.ts`:

- `MCP_HTTP_API_KEY` gates the MCP endpoint (`isApiKeyMatch`: `timingSafeEqual`
  on equal-length buffers; a length mismatch still pays one full comparison and
  answers `false` — hashing both sides to equalise lengths trips CodeQL's
  `js/insufficient-password-hash`, and the length of a random key is not
  secret). The
  `401` carries `WWW-Authenticate: Bearer realm="…"` **without**
  `resource_metadata` — there is no authorization server to discover, and the
  RFC 9728 document is not served in this mode. `/healthz` stays open.
- `assertStaticAuthPolicy` **refuses to start** (throws before `listen`) on
  static auth + non-loopback bind + no key, unless
  `MCP_HTTP_INSECURE_STATIC_AUTH=1`. A warning on stderr is exactly what
  `docker run -e BOOND_HTTP_STATIC_AUTH=true` does not read.
- A `warn` log at start-up states the mode's perimeter (key configured /
  loopback only / insecure).

Request bodies are capped at 1 MiB (`MAX_BODY_BYTES`): a `Content-Length`
precheck, then a streaming guard in `readJsonBody`, which is the **only** body
reader on the MCP endpoint — every POST (stateless, existing stateful session,
`initialize`) is buffered there and handed to the SDK as `parsedBody`, because
the SDK's own reader has no ceiling (issue #227: before, only the `initialize`
path was capped, and a chunked transfer without `Content-Length` bypassed the
precheck on the other two). Oversized requests get `413` with
`Connection: close` (the stream is left unread past the overflow, so the
connection must not be reused); an unparseable body gets `400` / `-32700`
rather than `undefined`, which would send the SDK back to a drained stream.
Pinned end-to-end in `http.test.ts` with chunked bodies on both paths.

**Liveness probe**: `GET /healthz` (unauthenticated, exempt from Host
validation so Docker/Kubernetes probes always pass) returns
`{ status, version, mode, sessions }`. The Docker image's `HEALTHCHECK`
uses it.

**Session ownership** (issue #232): a stateful `SessionEntry` records the
`currentAuthIdentity()` of the `initialize` that opened it, and every later
request naming that session is checked against the caller's identity. A
mismatch is answered **exactly like an unknown session** — `404` /
`-32001 Session not found`, same body — so a leaked `Mcp-Session-Id` (log,
proxy) plus any Bearer can neither attach to another user's GET stream, read
their progress notifications, nor answer their delete elicitations, and the
probe does not learn whether the id exists. An unknown id on a non-initialize
request also gets that `404` now (it used to be `400`); a POST `initialize`
carrying a stale id still opens a new session. In static-auth mode every
caller shares the `env` identity, which collapses to the previous behaviour.
Pinned in `http.test.ts` (POST / GET / DELETE with another Bearer).

**Shutdown** (issue #237): `handle.close()` is memoised — a second call (a
second SIGTERM, Kubernetes retrying, an operator's Ctrl-C after Docker's
signal) returns the same in-flight promise instead of calling `server.close()`
on a closed server and leaving an unhandled `ERR_SERVER_NOT_RUNNING`. The
signal handler in `src/index.ts` is idempotent for the same reason and arms a
forced exit at `shutdownTimeoutMs + 2 s`. Node's `close()` reaps idle
keep-alive sockets **once**; a socket still draining a body at that instant
(the 413 precheck answers before the 2 MiB body is consumed) is never
re-checked and, with a 65 s keep-alive, would hold the close for the whole
grace period — so `close()` repeats `closeIdleConnections()` every 100 ms
until the server is closed. The 413 precheck stays a plain 413 without
`Connection: close`: Node drains the announced body itself, and closing early
makes a client still uploading see a reset instead of the 413 (undici's
`fetch` rejects). Pinned end-to-end in `src/http-shutdown.test.ts`, which spawns
`dist/index.js`, opens a request that never completes, sends SIGTERM twice and
asserts exit code 0 within the grace period.

Stateless mode spins up a fresh `McpServer`+`StreamableHTTPServerTransport` per POST. Stateful mode keeps a `sessionId → { transport, server, lastActivityAt, ownerIdentity }` map; a periodic sweep closes idle sessions (transport + McpServer) so a buggy client that disconnects without `onsessionclosed` cannot leak resources. The sweep timer is `unref()`'d so it never blocks shutdown. The handle exposes `sessionCount()` and `sweepIdleSessions()` for observability/tests.

## Authentication

Two distinct models depending on the transport — **stdio** uses the
existing env-based credentials (single identity, integrator-side);
**http** is an **OAuth2 protected resource** (multi-tenant, per-user,
per-request).

### stdio transport (env-based, priority order)

1. **JWT from components** (recommended):
   - `BOOND_USER_TOKEN` — User token (BoondManager → Mon compte → Clé d'API)
   - `BOOND_CLIENT_TOKEN` — Client token (Administration → Espace Développeur → API / Sandbox)
   - `BOOND_CLIENT_KEY` — Client secret key (Administration → Espace Développeur → API / Sandbox)
   - The server generates the JWT (HS256) automatically from these 3 values.
   - Optional: `BOOND_JWT_TTL_SECONDS` adds `iat`/`exp` claims and regenerates
     the JWT per request so a leaked token expires (bounded replay window).
     Absent/0 = legacy behaviour (token built once, no expiry). Opt-in because
     not every BoondManager deployment is known to honour `exp`.
2. **Pre-built JWT**: `BOOND_API_TOKEN` (JWT Bearer)
3. **BasicAuth**: `BOOND_USER` + `BOOND_PASSWORD` (base64-encoded)

JWT travels in `X-Jwt-Client-Boondmanager`, BasicAuth in `Authorization`.

### http transport (OAuth2 — protected resource model)

The HTTP server is an **OAuth2 protected resource** (per the MCP
Authorization 2025-06-18 spec and RFC 9728). It holds **no OAuth state**:
no `client_secret`, no refresh token, no per-user storage. The flow:

1. The MCP client (Claude Desktop, Claude Code, gateway, …) initiates
   the OAuth dance against BoondManager directly. The user grants
   consent to the BoondManager App in their browser; the client receives
   an `access_token` and a `refresh_token`.
2. On every MCP request the client sends
   `Authorization: Bearer <access_token>`.
3. The HTTP transport (`src/transports/http.ts`) extracts the Bearer
   token before dispatching to the SDK's `StreamableHTTPServerTransport`,
   wraps the handler in `oauthContext.run({ accessToken }, …)`.
4. When a tool fires an API call, `oauthContextAuth` in `http/auth.ts`
   reads the token out of the AsyncLocalStorage context and forwards it
   verbatim to BoondManager as `Authorization: Bearer <access_token>`.
5. The MCP client refreshes its own tokens — the server never sees the
   refresh flow. When the access token expires or is revoked, BoondManager
   answers 401 *inside* a tool call; the tool error says so and names
   re-authorization as the remedy (`hintForUnauthorized`, issue #234 — the
   historical hint named a `boondmanager-mcp-oauth-login` CLI that is no
   longer shipped). To make the client re-authorize **on its own**, enable
   `MCP_HTTP_VALIDATE_TOKEN=true`: the transport then answers the request
   itself with `401` + `error="invalid_token"` (see *Transports*).

Discovery: the server publishes RFC 9728 protected-resource metadata at
`/.well-known/oauth-protected-resource` (and at the path-suffixed variant
`/.well-known/oauth-protected-resource{MCP_HTTP_PATH}` per RFC 9728 §3.2).
Missing/invalid Bearer tokens get a 401 with
`WWW-Authenticate: Bearer realm="…", resource_metadata="…"` pointing at
that endpoint. MCP-spec-compliant clients use this to auto-discover the
BoondManager authorization server.

Env vars for the HTTP path (all optional — only `MCP_HTTP_PUBLIC_URL`
really matters in production):

| Var | Purpose |
|-----|---------|
| `MCP_HTTP_PUBLIC_URL` | Public URL advertised as the OAuth2 resource identifier (and in the `realm` of the 401 challenge). Required when fronted by a reverse proxy. Defaults to `http://<host>:<port><path>`. |
| `BOOND_OAUTH_AUTHORIZATION_SERVER` | Issuer URL of the BoondManager authorization server, advertised in `authorization_servers`. Defaults to `https://ui.boondmanager.com`. |
| `BOOND_OAUTH_SCOPES` | Space/comma-separated scope hints advertised in `scopes_supported`. Empty = clients negotiate directly with Boond. |

Implementation: `src/services/oauth.ts` (AsyncLocalStorage context,
header parsing, metadata builder), `src/transports/http.ts` (Bearer
extraction + discovery endpoint + 401 challenge), `src/services/http/auth.ts`
(`oauthContextAuth` provider). Full setup guide: `docs/oauth.md`.

- `BOOND_BASE_URL` (optional, defaults to `https://ui.boondmanager.com/api`)
- `BOOND_HTTP_TIMEOUT_MS` (optional, defaults to `30000`) — per-request timeout for the BoondManager HTTP client. Non-numeric / non-positive values fall back to the default. A timeout surfaces as an `Error` whose message includes the configured value and the failing endpoint.
- `BOOND_HTTP_MAX_RETRIES` (optional, defaults to `2`) — number of additional attempts after the first failure. Set to `0` to disable retries. Retry policy: GET retries on 5xx / 429 / network / timeout; non-GET retries only on 429 (idempotency safety). `Retry-After` is honoured.
- `BOOND_HTTP_RETRY_BASE_MS` / `BOOND_HTTP_RETRY_MAX_MS` (optional, defaults `200` / `5000`) — full-jitter exponential backoff: `random(0, min(maxMs, baseMs * 2^attempt))`.
- `BOOND_HTTP_RATE_LIMIT_RPS` / `BOOND_HTTP_RATE_LIMIT_BURST` (optional, defaults `10` / `20`) — client-side token bucket guarding the BoondManager API. Each attempt (including retries) consumes one token. Set RPS to `0` to disable. Implementation in `src/services/rate-limiter.ts`; tests can swap the bucket via the exported `resetRateLimiterForTests()`. **One bucket per caller identity** (`currentAuthIdentity()` in `oauth.ts`, issue #232): `sha256(Bearer)` under the HTTP OAuth transport, so one user's burst never throttles another and one buggy client cannot hold the deployment at the limit; the constant `env` identity on stdio / static auth, so those keep exactly one bucket. The map is LRU-bounded at `MAX_RATE_LIMIT_BUCKETS` (500). The limit is therefore *per identity*, not per process — fairness between users, not a lower ceiling towards BoondManager.
