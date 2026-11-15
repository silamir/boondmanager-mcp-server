---
paths:
  - "src/config/**/*.ts"
  - "src/server.ts"
  - "src/prompts/**/*.ts"
  - "docs/access-control.md"
---

# Access control and environment readers

<!-- Moved verbatim from CLAUDE.md; loaded only when Claude works on the files above. -->

## Access Control (domain / operation restriction)

Operator-side, env-driven filtering of the exposed surface. Implemented in
`src/config/access-policy.ts` and wired in `src/server.ts::registerAll`. **Not
a hard security boundary** — it hides tools/prompts from the model but the
configured BoondManager credentials keep their rights (the real wall is the
Boond account/role). Full guide: `docs/access-control.md`.

Env vars (all optional, absent = full surface = legacy behaviour):

| Var | Effect |
|-----|--------|
| `BOOND_MCP_PROFILE` | CSV of pre-composed profiles (`recruiting`, `sales`, `finance`, `delivery`, `admin`), unioned. Ignored when `DOMAINS` is set. |
| `BOOND_MCP_DOMAINS` | CSV allow-list of domains. Absent = all. Dashes/underscores both accepted. |
| `BOOND_MCP_EXCLUDE_DOMAINS` | CSV deny-list, applied after the allow-list (deny wins). |
| `BOOND_MCP_OPERATIONS` | CSV of `read,create,update,delete`. Absent = all. Precedence over READ_ONLY. |
| `BOOND_MCP_READ_ONLY` | Boolean (`1/true/yes`) shortcut for `OPERATIONS=read`. |

Key design points (so future changes don't regress them):

- **Domain filtering couples domain ↔ registrar** via the exported
  `TOOL_REGISTRARS` array in `server.ts` (same list the TOOLS.md generator
  consumes). No regex on tool names, so multi-word domains like
  `provider-invoices` can't false-match `invoices`.
- **Operation filtering is a `Proxy`** (`withPolicy`) around the McpServer that
  drops a tool whose `operationOf(annotations)` is not allowed. Fast-path:
  returns the server untouched when all operations are allowed. Operation is
  derived from annotations: `readOnlyHint→read`, `destructiveHint→delete`,
  `idempotentHint→update`, else `create`.
- **Prompts** carry a `domains: DomainName[]` field (in `src/prompts/index.ts`);
  a prompt is cut if any of its domains is disallowed. **Workflow tools**
  (`boond_workflow_*`) mirror prompts 1:1 and follow the *same* rule (they are
  NOT gated by allow-list membership of the `workflows` domain; a prompt and
  its mirror appear/disappear together; an explicit `EXCLUDE_DOMAINS=workflows`
  still drops the tool-form only).
- **Static reference resources are never filtered** (lookup substrate /
  dictionaries / `current-user`); **entity templates follow their entity's
  domain**. The old blanket rule was right for code tables and wrong for
  business records: with `BOOND_MCP_PROFILE=finance`, `candidates` is gone from
  `tools/list`, and leaving `boond://candidate/{id}` readable reopens exactly
  what the operator closed.
- New signatures (`registerAllPrompts(server, policy?)`,
  `registerAllResources(server, policy?)`,
  `registerWorkflowTools(server, policy?)`) keep `policy` **optional** so the
  catalogue generator and existing tests register the full surface unchanged —
  this is what keeps `TOOLS.md` from drifting.
- The policy is resilient: unknown domains/operations/profiles are
  warned-and-ignored, never fatal — an all-invalid `PROFILE` falls back to the
  full surface rather than an empty one. Excluding `application` logs a
  guard-rail warning (it backs dictionary/current-user resolution).
- **Profiles** (`src/config/profiles.ts`) are job-shaped domain bundles, not a
  security tier — a usability layer over `DOMAINS`, which stays the precise
  tool. Precedence on the domain axis: `DOMAINS` > `PROFILE` > all, then
  `EXCLUDE_DOMAINS` in every case. `application` is in every profile (it backs
  dictionary/current-user). `resources` is in `recruiting`, `sales` and
  `delivery` but **not** in `finance` / `admin` — there is no "resources
  everywhere" rule: a prompt is cut as soon as ONE of its domains is filtered out
  and 8 of the 11 orchestrate `resources`, so leaving it out of the first three
  bought ~10 fewer tools and cost most of their runbooks, while `finance` /
  `admin` have no runbook that touches it. When adding a profile, check the
  **prompt** count, not just the tool count. Both are **generated** — see
  `docs/access-control.md`.
- `registerAll(server, policy, index?)` also wraps each registrar in
  `decorateRegistrations` (search-schema hints + tool→domain index for icons).
  That wrapper is **not** merged into `withPolicy`, whose fast path returns the
  server untouched when no operation filter is active.

### Empty env values are "unconfigured" (both packaged channels)

The MCPB manifest and the plugin `.mcp.json` both substitute
`${user_config.KEY}` into **all fourteen** `BOOND_*` vars, so every var is
*defined* even for options the user never touched — a half-filled form hands the
server empty strings, not absent keys. Three shapes must therefore all read as
"not set": `""`, whitespace only, and an unsubstituted `"${…}"`.

This is the mirror of the `MCP_HTTP_ALLOWED_HOSTS` rule (a blank value must never
silently switch a control *off*): here a blank value must never switch a
restriction *on*, which would hide most of the catalogue with no visible cause.
**One reader implements it: `src/config/env.ts`** (`readString`, `readBool`,
`readPositiveInt`, `readCsv`, `readUrl`; issue #242). Six private readers used
to coexist and only one rejected whitespace — `MCP_HTTP_PATH=" "` became the
endpoint path, `BOOND_OAUTH_AUTHORIZATION_SERVER=" "` broke the discovery
document, `BOOND_BASE_URL=" "` failed as an opaque fetch error. Do not read
`process.env` directly in a module; import the reader (every function takes
`env` as its last argument for the config modules that are tested with a
fake environment). `readUrl` is the one reader that **throws** on a value
that is present but malformed: the three URLs decide where credentials are
sent or where clients are told to go, so a typo stops start-up with the
variable's name instead of surfacing as a fetch error. `readCsv` returns
`undefined` for a list with no token (`" , "`), so "nothing" never means
"allow nothing". `src/config/env.test.ts` walks every documented variable
through the three unset shapes.

Both booleans (`mcp_read_only`, `confirm_delete`) arrive as *strings* and carry
an explicit `default`. `"false"` must not read as "set, therefore on"; and every
ambiguous value resolves in the safe direction — all operations allowed for
read-only, confirmation *kept* for deletes. Pinned in
`access-policy.test.ts`, `env-flags.test.ts`, `dictionary-overrides.test.ts`,
`http/auth.test.ts` and `http/transport.test.ts`.
