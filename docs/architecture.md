# Architecture

Source map of `src/`, moved out of `CLAUDE.md` (Claude reads the tree itself; this is the
annotated version for humans and for the few non-obvious roles a file name does not say).

```
src/
├── index.ts              # Entry point: initClient(), selects transport (stdio or http) via MCP_TRANSPORT
├── server.ts             # createMcpServer() factory — instantiates McpServer (name/version/description + instructions) + registers tools/prompts/resources
├── instructions.ts       # SERVER_INSTRUCTIONS — cross-cutting usage rules sent once at initialize
├── icons.ts              # DOMAIN_ICONS (SEP-973) + installProtocolIcons() — decorates tools/list & prompts/list responses
├── schema-dialect.ts     # installSchemaDialectCompat() — strips the SDK's draft-07 `$schema` from advertised input/outputSchema
├── constants.ts          # DEFAULT_BASE_URL, pagination limits, API_PATHS, ENTITY_TABS
├── types.ts              # JsonApiResource, JsonApiResponse, BoondConfig, SearchParams
├── transports/
│   └── http.ts           # startHttpTransport() + resolveHttpOptions() — MCP Streamable HTTP server + GET /healthz (liveness, non authentifié)
├── services/
│   ├── boond-client.ts   # Barrel — the ONLY path tools, transports, resources and test mocks import from. Implementation below (issue #239)
│   ├── http/
│   │   ├── auth.ts       # Config + auth providers: initClient() (stdio JWT / token / BasicAuth), initClientWithAuth() (OAuth), oauthContextAuth (reads AsyncLocalStorage), buildJwt()
│   │   ├── errors.ts     # parseBoondErrorBody(), formatApiError() (+ Cloudflare detection, status hints), BoondApiError, timeoutError(), nonJsonResponseError()
│   │   ├── retry.ts      # Retry policy: resolveRetryConfig(), isRetryable(), parseRetryAfter(), computeBackoffMs()
│   │   ├── rate-limit.ts # Per-identity token buckets (getRateLimiter(), LRU-bounded at MAX_RATE_LIMIT_BUCKETS)
│   │   ├── transport.ts  # send() — the single fetch path (URL guard, bucket, auth per attempt, timeout, retries, error mapping); apiRequest(), apiUploadForm()
│   │   └── download.ts   # apiDownload(): streaming under maxBytes, byte progress, app-shell guard, DownloadTooLargeError
│   ├── search.ts         # buildSearchQuery() + apiSearch() (per-route maxResults chunking + progress)
│   ├── format/
│   │   ├── summary.ts    # formatEntitySummary() (+ business-identifier fallback), formatProjectedSummary() (`fields`), renderAttributeValue()
│   │   ├── html.ts       # textExcerpt() / decodeHtmlEntities() for HTML note fields
│   │   ├── list.ts       # formatListResponse() — one line per row, line-boundary truncation
│   │   ├── detail.ts     # projectEntity() + formatDetailResponse()
│   │   └── tab.ts        # formatTabResponse()
│   ├── oauth.ts          # OAuth2 protected-resource plumbing for the HTTP transport: oauthContext (AsyncLocalStorage), extractBearerToken(), buildProtectedResourceMetadata() (RFC 9728). No state, no client_secret.
│   ├── progress.ts       # progressReporterFrom(extra) — notifications/progress reporter, no-op without a client progressToken
│   ├── rate-limiter.ts   # Token-bucket rate limiter for BoondManager API
│   └── logger.ts         # Structured logger (pino) + generateCorrelationId()
├── schemas/
│   ├── index.ts          # Zod schemas: SearchSchema, IdSchema, IdTabSchema, plus per-domain search/create/update schemas
│   └── filter-aliases.ts # Wrong-filter-name → correction table + unknownFilterMessage() (feeds the search schemas' error messages)
├── prompts/
│   └── index.ts          # registerAllPrompts() — 12 pre-orchestrated workflow templates
├── resources/
│   ├── index.ts          # registerAllResources(server, policy?) — static boond://dictionary/* + boond://application/current-user, then the entity templates
│   └── templates.ts      # ENTITY_TEMPLATES (boond://candidate/{id}, …) + readEntityAggregate() — aggregated read, id guard, MAX_RESOURCE_BYTES ceiling
└── tools/
    ├── index.ts          # Barrel export of all register*Tools functions
    ├── crud-factory.ts   # Generic CRUD tool factory (registerSearchTool, registerGetTool, etc.) + structured output schemas + confirmDeletion() (elicitation)
    ├── description-builders.ts    # composeDescription() + the five CRUD templates + tabDescription() — the tool-description contract
    ├── tab-tools.ts               # registerTabTools() — the 48 entity-tab tools, one loop instead of nine
    ├── parameter-disclosure.ts    # withParameterDisclosure() — discloses `fields` / pagination semantics on the tools that declare them
    ├── usage-guidance.ts          # USAGE_GUIDANCE — per-tool "when / rather than" for the hand-rolled tools, backfilled centrally
    ├── validation-wrapper.ts      # withFilterHints() — rebuilds *_search schemas with model-actionable unknown-key messages
    ├── registration-decorators.ts # Per-domain registerTool Proxy: applies the above + records tool→domain for icons
    └── *.ts              # One file per domain (38 tool files; documents.ts = download/upload/delete de documents & CV)

scripts/
└── generate-tools-catalog.mjs  # Builds TOOLS.md from the dist/ registrations (CI drift-checked)

docs/
└── distribution.md       # Where the server ships (npm, MCP Registry, GHCR, LobeHub, Smithery) + manual outreach checklist

# Top-level metadata
manifest.json             # MCPB manifest (Claude Desktop one-click install) — source of truth for user_config
server.json               # MCP Registry manifest
smithery.yaml             # Smithery.ai listing config
Dockerfile + .dockerignore # Multi-arch Docker image (HTTP transport)
CHANGELOG.md              # Per-version release notes (consumed by release.yml)
SECURITY.md               # Disclosure policy
TOOLS.md                  # Auto-generated tool catalogue

.claude-plugin/marketplace.json           # Claude Code plugin marketplace (hand-written, 1 entry)
plugins/boondmanager-mcp/                 # The plugin itself — GENERATED, do not hand-edit
  .claude-plugin/plugin.json              #   metadata + userConfig (ported from manifest.json)
  .mcp.json                               #   stdio server: npx boondmanager-mcp-server@X.Y.Z
scripts/generate-plugin-manifest.mjs      # Generates both (npm run plugin:manifest[:check])
```

