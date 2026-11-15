---
paths:
  - "src/server.ts"
  - "src/instructions.ts"
  - "src/icons.ts"
  - "src/schema-dialect.ts"
  - "src/tools/registration-decorators.ts"
  - "package.json"
---

# MCP protocol surface: spec level, identity, icons, schema dialect, list order

<!-- Moved verbatim from CLAUDE.md; loaded only when Claude works on the files above. -->

## MCP Spec Level

- **Negotiated**: whatever the installed SDK advertises. `@modelcontextprotocol/sdk@1.30.0`
  has `LATEST_PROTOCOL_VERSION = '2025-11-25'`, so that is the revision the server
  speaks (the transport does not pin a version of its own).
- **Features used from `2025-11-25`**: server-level `instructions`
  (`src/instructions.ts`), `Implementation.description`, `Origin` header
  validation → `403` (`src/transports/http.ts`), `icons` on tools/prompts/
  resources (SEP-973, `src/icons.ts`), titled single-select enum + default in
  the delete elicitation (SEP-1330/SEP-1034, `src/tools/crud-factory.ts`),
  self-correctable argument-validation errors (SEP-1303,
  `src/tools/validation-wrapper.ts`).
- **Current published revision**: `2026-07-28` — not adopted yet. What is (and
  isn't) worth adopting from it is tracked in
  [issue #170](https://github.com/silamir/boondmanager-mcp-server/issues/170).
- Keep this section honest when the SDK is bumped: the SDK's
  `LATEST_PROTOCOL_VERSION` is the only source of truth for what is negotiated.
- **Minimum SDK is `^1.30.0`** (`package.json`, issue #246): the features
  listed above (`ResourceTemplate`, the titled elicitation enum, the 2025-11-25
  negotiation) do not exist in 1.29, so a looser range would let `npm install`
  resolve a version the code does not run on.

## Server Identity & Instructions

`createMcpServer()` advertises three things at `initialize`:

- `name` (`SERVER_NAME`) and `version` (`SERVER_VERSION`, read from `package.json`)
- `description` (`SERVER_DESCRIPTION`, also read from `package.json` — deliberately
  *not* a fifth hardcoded string to sync at release time)
- `instructions` (`SERVER_INSTRUCTIONS`, `src/instructions.ts`)

`src/instructions.ts` holds **cross-cutting rules only** — tool naming, the
perimeter filter gotchas, the `keywords` prefix syntax, pagination/`fields`
token economy, and dictionary resolution via `boond://dictionary/*`. It exists
so those rules are stated **once** instead of once per tool description (182
tools × boilerplate is paid on every turn). Per-tool specifics stay in the tool
descriptions and `src/schemas/index.ts`.

Length is capped at `MAX_SERVER_INSTRUCTIONS_LENGTH` (4000) and asserted in
`src/tools/descriptions.test.ts` — the instructions compete with the tool
catalogue for the same context budget.

## Icons (SEP-973)

`src/icons.ts` gives every tool, prompt and resource an `icons` entry.

- **Scope is per *domain*, not per tool** (38 glyphs, not 182): the icon groups
  the catalogue, the name distinguishes inside the group.
- **Format**: inline `data:image/svg+xml` URI, 16×16 single-path glyph, one
  neutral colour (a data URI can't inherit `currentColor`, and a light/dark pair
  would double the payload). No `mimeType`/`sizes` — the URI carries the type and
  SVG is scalable. Path data uses `,` separators so nothing needs `%20`.
- **Byte cost is the design constraint**: icons ride on *every* `tools/list`
  entry — measured **~40 KiB, ~14 % of the 283 KiB payload**. Capped in
  `src/tools/descriptions.test.ts` (absolute + share-of-payload) and per-icon in
  `src/icons.test.ts`. Opt-out: `BOOND_MCP_ICONS=0|false|no|off`.
- **Delivery mechanism**: SDK 1.30 types `icons` on `Tool`/`Prompt` but its
  `McpServer` list handlers build entries field by field and drop it, so
  `installProtocolIcons()` wraps the `tools/list` / `prompts/list` handlers via
  the public `Server.setRequestHandler` (schema identity, no private fields).
  It must run **before** the first registration. Resources need no shim — their
  listing spreads the whole config, so `registerResource` carries `icons`
  natively. When the SDK supports icons directly, delete the shim and pass
  `icons` in the registration config; `src/icons.test.ts` asserts icons over a
  real client, so the swap can't silently lose them.
- Tool → domain comes from the registration index built in `registerAll`
  (`src/tools/registration-decorators.ts`), never from parsing tool names — so
  `boond_provider_invoices_*` and `boond_workflow_*` get the right glyph.
- The TOOLS.md generator ignores icons on purpose (it renders a text catalogue).

## No JSON Schema Dialect on Advertised Schemas

`src/schema-dialect.ts::installSchemaDialectCompat()` strips `$schema` from
every `inputSchema` / `outputSchema` in `tools/list`. Same shim mechanism and
same "before the first registration" constraint as `installProtocolIcons`.

Why it exists: the SDK converts Zod v4 schemas with
`z.toJSONSchema(schema, { target: 'draft-7' })` (hardcoded in
`server/zod-json-schema-compat.js`, no option to change or omit), which stamps
`"$schema": "http://json-schema.org/draft-07/schema#"` on all 239 advertised
schemas. A host that validates `structuredContent` with a **2020-12-only**
validator (`Ajv2020`) refuses to *compile* such a schema —
`no schema with key or ref "http://json-schema.org/draft-07/schema#"` — and that
happens at client-side tool registration, i.e. **before any call**: the tool
doesn't fail, it disappears.

The symptom is asymmetric and misleading, so recognise it: only the **59 tools
that declare an `outputSchema`** (every `*_search`, plus create/update/delete)
break, while the ~120 without one (`*_get`, dictionaries, reporting) keep
working — even though *all 182* carry the same `$schema` on their `inputSchema`.
A client in that state can only re-read entities whose id it already knows.

Design points, each with a test in `src/schema-dialect.test.ts`:

- **Declaring nothing, not declaring 2020-12.** `$schema` is not part of MCP's
  `Tool.inputSchema` / `Tool.outputSchema` shape, and the catalogue uses no
  dialect-specific keyword (no `$ref`, no `$defs`, no `definitions`) — so every
  validator reads the schemas identically under its own default dialect.
  Announcing 2020-12 would just move the break to draft-07-only validators, the
  MCP SDK's own client among them (plain Ajv 8, draft-07 by default).
- **Only *string* `$schema` members are removed.** A property *named* `$schema`
  inside `properties` is a schema **object**; a blind recursive delete would
  silently drop it from the advertised input shape.
- `stripSchemaDialect` returns its input **by identity** when there is nothing to
  strip, so the day the SDK stops emitting the declaration this costs nothing.
- Bonus: ~10 KiB off `tools/list` (282.9 KiB instead of 293.4).

Deletable the moment the SDK omits `$schema` or lets us pick the target — the
test asserts over a real client, so the regression can't return quietly.

## Deterministic `tools/list` Order

The 2026-07-28 revision recommends a deterministic `tools/list` order (client
caching + prompt-cache hit rate). The SDK lists tools in registration order, so
the guarantee reduces to: `TOOL_REGISTRARS` order is stable, and no registrar
introduces non-determinism (iterating a `Set`, `Object.keys` of a dynamically
built object, an async race). `ENTITY_TABS` loops are ordered arrays, so they are
fine. `src/server.test.ts` pins three properties: two `registerAll` runs produce
the same tool sequence, two real servers advertise the same order over the wire,
and the sequence equals the concatenation of each registrar's own output in
`TOOL_REGISTRARS` order. Treat the array order as API, not style.
