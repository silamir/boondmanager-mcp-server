---
paths:
  - "src/services/**/*.ts"
  - "src/tools/registration-decorators.ts"
  - "src/index.ts"
---

# BoondManager HTTP client: send path, errors, logging, progress, cancellation

<!-- Moved verbatim from CLAUDE.md; loaded only when Claude works on the files above. -->

**Error formatting** (`src/services/http/errors.ts`): non-2xx responses
are surfaced through `formatApiError()` which uses
`parseBoondErrorBody()` to extract `errors[].detail` from BoondManager's
JSON:API error envelope and adds a status-specific `Hint:` line. The raw
body is only included as a fallback when the response isn't structured
JSON. Both helpers are exported for unit testing.

**One send path** (`src/services/http/transport.ts::send()`, issue #239):
`apiRequest`, `apiUploadForm` and `apiDownload` are thin wrappers over a
single `send(path, { method, query, body, headers })` that returns the first
2xx `Response` with its body unread. Everything that used to be copied three
times — and had drifted — lives there once: path guard, per-identity bucket,
auth header resolved *per attempt* (an OAuth refresh between two tries is
picked up), per-attempt `AbortSignal.timeout`, retry policy with `Retry-After`,
error mapping. Consequences pinned by tests: a multipart upload timeout is
reported with the endpoint and the `BOOND_HTTP_TIMEOUT_MS` hint (it used to
leak a bare `TimeoutError`), an upload honours a 429 (the same `FormData` is
resent — `fetch` re-serialises it per call), a document download retries a
transient 5xx like any other GET (it used to be a single attempt), and a 2xx
whose body is not JSON names the endpoint instead of surfacing a raw
`SyntaxError`. A new helper must go through `send()`; if it calls `fetch`
itself it will diverge the same way.

**Structured logging** (`src/services/logger.ts`): Pino-based logger
with level control via `LOG_LEVEL` (trace/debug/info/warn/error/fatal)
and format via `LOG_FORMAT` (json vs pretty). Every HTTP request gets a
`corrId` (8 hex chars) for tracing through the stack. Use `logger.child()`
to attach context and `logger.info({ key: value }, "message")` for
structured output. In production (`NODE_ENV=production`), JSON is default;
in dev, pino-pretty (colorized) is active unless `LOG_FORMAT=json`.
`pino-pretty` is a **devDependency** (issue #246): the `.mcpb` bundle and the
Docker image are built with `--omit=dev`, so `resolveLoggerConfig()` takes the
pretty branch only when `isPrettyTransportAvailable()` resolves the module
and falls back to JSON on stderr otherwise (pino would throw at logger
creation on a missing transport target). Docker base image: the **active
LTS** line (`node:24-alpine`), never current — policy in `README-docker.md`.

**What is logged, and where the `corrId` comes from** (issue #236). Four
sources, one id:

- **HTTP access log** (`src/transports/http.ts`): one line per request on
  `finish` / `close` — `{ corrId, method, path, status, durationMs }`, plus
  `reason` on the rejections the handler writes itself (401 / 403 / 413 / 400 /
  404 session / 405 / 503) at `warn`, 5xx at `error`, `/healthz` at `debug`,
  `aborted: true` when the client left first. `path` is the URL **without its
  query string**, on purpose.
- **Tool log** (`src/tools/registration-decorators.ts::instrumentHandlers`):
  `{ corrId, tool, durationMs, ok, chars }` at `info` for every `tools/call`
  (`ok` is false on an `isError` result), `warn` + rethrow on a throwing
  handler. One wrapper for ~185 tools; prompts and resources get the context
  but no line.
- **BoondManager client** (`src/services/http/transport.ts::send()`): `debug`
  per completed attempt `{ corrId, method, path, attempt, status, durationMs }`;
  `warn` on a retried attempt (`status` or `reason: "timeout" | "network"`,
  `totalAttempts`, `backoffMs`), on a final 429 and on a timeout; an ordinary
  final 4xx stays at `debug` (the tool log already says `ok: false`). Never the
  query string, never a header.
- **Correlation**: the id is, in order, the W3C `trace-id` of a
  `_meta.traceparent` the client sent (SEP-414, validated by `parseTraceparent`),
  the id the HTTP transport generated for the connection
  (`runWithRequestContext({ corrId }, dispatch)`), or a fresh
  `generateCorrelationId()` on stdio. `send()` forwards it to BoondManager as
  `X-Request-Id`, and `traceparent` verbatim when present — header propagation
  only, no tracing SDK. **`_meta.baggage` is never read and never logged** (it
  may carry end-user identifiers); pinned in `registration-decorators.test.ts`
  and `http/observability.test.ts`. The transport → tool → client chain is
  asserted end-to-end in `http.test.ts` (the `X-Request-Id` BoondManager
  receives equals the access-log `corrId`).

**Every log line goes to stderr, on both transports** (`LOG_DESTINATION_FD`,
issue #225). On stdio, stdout *is* the JSON-RPC stream: anything else written
there corrupts a frame and the client drops the connection. Pino defaults to
fd 1, and so does the pino-pretty transport without a `destination` — which is
how the "Access policy active" line (any `BOOND_MCP_PROFILE` / `READ_ONLY`
user), the update notice and the dictionary-override warnings used to land
between two protocol messages. The two output shapes are built by
`resolveLoggerConfig()` and both name fd 2: as `pino.destination(2)` on the
JSON branch, as `transport.options.destination` on the pretty branch (pino
refuses a stream argument alongside `transport`, which runs in a worker
thread). Pinned twice: `logger.test.ts` on the config, and
`src/stdio-stdout.test.ts` end-to-end — it spawns the real `dist/index.js`
with an invalid access policy, sends `initialize`, and asserts that every
stdout line parses as JSON-RPC while the warnings are on stderr. The child
process is the only vantage point that sees the defect: neither the worker
thread nor a SonicBoom on a raw fd goes through `process.stdout`, so an
in-process spy stays green. CI builds before testing for that reason; locally
the test compiles on demand rather than skipping. The `console.error` banners
in `src/index.ts` were already on stderr.

## Progress Notifications (`notifications/progress`)

A few tool calls fan out into several sequential BoondManager requests behind a
single `tools/call` — `apiSearch` on the chunked path (`pageSize: 500` on
`/actions` = 5 API calls), a wide `boond_reporting_*` aggregation, a 5 MiB
`boond_documents_get`. Without a signal the client sees one slow call,
indistinguishable from a hang. Everything goes through one helper,
`src/services/progress.ts`:

```ts
progressReporterFrom(extra)  // extra = the SDK's RequestHandlerExtra
```

Design rules, each pinned by a test:

- **No `progressToken`, no notification.** The spec only allows a progress
  notification when the client put a token in the request's `_meta`;
  `progressReporterFrom` returns a shared **no-op** otherwise. That is what
  makes the feature safe for clients that ignore progress: a tokenless call is
  byte-for-byte the previous execution, asserted by comparing both results.
- **Narrowing lives in the helper, not in ~180 handlers.** `extra` is typed
  `unknown` at every call site; handlers that never opt in simply don't take it.
- **A broken progress channel never costs the caller its result.** Sends are
  fire-and-forget (`void`, never awaited) and both a rejected promise and a
  synchronous transport throw are swallowed.
- **`progress` strictly increases, `total` stays constant** for a token.
  `apiSearch` emits one step per fetched chunk (`n/totalChunks`) and, when the
  result set runs out early, one closing step at `total` so the client's bar
  doesn't stall at 2/5.
- **The `apiSearch` fast path stays silent.** A single API call has nothing to
  report and a "1/1" would be pure noise. `onProgress` is the optional *last*
  parameter, so no existing caller changed.
- **`boond_reporting_*` is the deliberate exception** to the previous rule: one
  request, but an aggregation over a wide perimeter can run for tens of seconds,
  so the handler brackets it with `0/1 … en cours` / `1/1 … terminé`. Here the
  "started" step *is* the signal that separates slow from hung.
- **`boond_documents_get` reports bytes**, throttled to ~10 steps, and only when
  the response carries a `Content-Length`. Since #235 `apiDownload` always
  streams the body (`body.getReader()`) because the size cap is enforced as
  bytes arrive; progress is an observer on that single path, gated by
  `ProgressReporter.enabled` + a known total, so a tokenless call reads the
  same bytes and emits nothing.

**Known limitation — `MCP_HTTP_JSON_RESPONSE=true`**: that mode answers with a
plain JSON body instead of an SSE stream, so there is no response stream to
carry request-scoped notifications and progress is silently dropped. Tool
results are unaffected. Documented next to the variable in *Transports*.

Out of scope on purpose: prompts and the `boond_workflow_*` mirrors. They return
a runbook instantly and it is the *model* that then chains the calls — there is
nothing server-side to instrument; the latency they are blamed for belongs to
the tools above.

`notifications/progress` is also durable: the 2026-07-28 revision keeps
request-scoped notifications explicitly, unlike Sampling / Roots / Logging which
it deprecates (see [issue #170](https://github.com/silamir/boondmanager-mcp-server/issues/170)).
It is not a substitute for Tasks and does not preempt that decision: progress is
a call that stays open and says where it is; a task is a call that returns a
handle immediately.

## Cancellation (`notifications/cancelled`)

Every handler receives `extra.signal`, an `AbortSignal` the SDK fires on
`notifications/cancelled` or when the transport closes. Since issue #231 it
reaches the socket: a cancelled `/actions` chunked search, reporting query or
5 MiB download stops instead of running to completion on rate-limit tokens
and BoondManager quota nobody will read.

- **The signal travels in an `AsyncLocalStorage`**
  (`src/services/request-context.ts`), not as a parameter: `instrumentHandlers()`
  (`src/tools/registration-decorators.ts`) is the innermost server wrapper in
  `registerAll` and runs every tool, prompt and resource handler inside
  `runWithRequestContext({ signal, corrId, traceparent }, …)`; `send()` reads
  it back with `currentRequestContext()`. The same context carries the
  correlation id (see *Structured logging*). Same pattern as the OAuth token — ~180 handler
  signatures and the client helpers are untouched. `SendOptions.signal` is an
  explicit override for a caller that holds its own.
- **Where it is checked**: before each attempt (`throwIfCancelled`), while
  queued on the rate limiter (`TokenBucket.acquire(signal)` rejects at once
  and does not poison the chain), during the fetch
  (`AbortSignal.any([signal, AbortSignal.timeout(ms)])`, so the body stream of a
  download aborts too), during a retry backoff (`sleep(ms, signal)`), and
  therefore between two chunks of `apiSearch`.
- **A cancellation is neither a timeout nor a retryable failure.** It surfaces
  as `RequestCancelledError` (`name: "AbortError"`, message naming the endpoint)
  and is never retried; an abort while the request's signal has *not* fired is
  still the timeout path. Pinned in `http/cancellation.test.ts`.
- **Shared work opts out.** The dictionary's in-flight load is awaited by every
  caller of the same `(identity, language)` key (#226); it runs under
  `withoutRequestSignal`, or one client cancelling would reject the dictionary
  for all the others (`dictionary.test.ts`).
- **End-to-end**: `src/server.test.ts` aborts a real `tools/call` and a real
  `resources/read` through the in-memory client and asserts the `fetch`-level
  signal is aborted — the MCP layer rejecting on its own proves nothing.
