---
paths:
  - "src/tools/**/*.ts"
  - "src/constants.ts"
---

# Tool registration: CRUD factory, tab tools, naming, annotations, structured output, delete confirmation

<!-- Moved verbatim from CLAUDE.md; loaded only when Claude works on the files above. -->

### Key Patterns

**CRUD Factory** (`src/tools/crud-factory.ts`): Generic functions to register
search/get/create/update/delete tools. Used by: candidates, resources,
contacts, companies, opportunities, projects, products, orders, expenses,
and — since issue #238 — contracts, deliveries, payments, purchases,
provider-invoices and timesheets (`boond_timesheets_default` and
`boond_resources_timesheets` stay hand-rolled: they are not CRUD). Call
signature: `registerSearchTool(server, opts, overrides?)` where
`opts = { entityName, entityNamePlural, apiPath, prefix }` and `overrides`
optionally swaps the default `SearchSchema` for a per-entity schema, overrides
the title/description, and hands a `summaryFn` to the list formatter *and* to
`structuredContent` (timesheets). A domain whose list and detail live on
different routes passes a different `apiPath` per registration (deliveries:
`/deliveries-groupments` for search, `/deliveries` for get). Relationships go
through `buildJsonApiBody`'s fourth argument in the domain's `build*Body`
function — never by casting `body.data.relationships` afterwards, which is
what six files used to do eleven times, without `outputSchema`, and on
`/payments` and `/provider-invoices` through `apiRequest` instead of
`apiSearch` (no chunking, no progress). Migrating a domain means: move its
schemas to `src/schemas/index.ts`, keep its hand-written descriptions as
`overrides.description` where they carry endpoint vocabulary, and remove its
row from `fields-projection.test.ts` (the factory forwards `fields` centrally).

**`GetToolOverrides.appendSection`**: a `_get` can append a section read from
another route, for data an entity only publishes there (orders: the correlated
deliveries / purchases, on `/orders/{id}/information`). The extra read runs in
parallel with the record, never on a `tab` read, and the hook turns its own
failure into text so the record is still returned. Disclose the extra call in
the get description, and bound the section: it is appended after
`CHARACTER_LIMIT` has been applied to the record.

**Tab tools** (`src/tools/tab-tools.ts`): Major entities (candidates, resources,
contacts, companies, opportunities, projects — and, since issue #258, invoices,
orders and purchases) register one extra tool per tab endpoint — 48 in total.
`ENTITY_TABS` (`constants.ts`) lists only tabs that are **wired**: a tab defined
there and registered nowhere is a trap (that is how `invoices` / `orders` sat
unexposed for months). `billable-items` is deliberately absent — probed live,
`GET /invoices/{id}/billable-items` answers 403 "missing contractual feature
(labs, appsNoCode)", and `/purchases/{id}/actions` 404s. `formatTabResponse`
renders `meta.totals` aggregates (everything but `rows`) ahead of the rows:
`boond_orders_invoices` is where BoondManager publishes ordered / invoiced /
remaining turnover, the input of billing preparation. Tool name pattern: `boond_{entity}_{tab_name}` (hyphens
replaced with underscores).

They all go through `registerTabTools(server, opts, tabs)`; a `TabDefinition`
supplies only `{ name, tab, title, subject, content?, returns }` and the
description is composed by `tabDescription()`. This was six byte-identical
registration loops in six domain files, each with its own copy of the
`TabDefinition` interface. Centralising matters beyond deduplication: these are
the catalogue's densest cluster of near-identical tools (same `IdSchema`, same
annotations, all "some fields of one entity"), so the one thing their
descriptions must do — name the slice *and* the sibling that reaches the rest —
now comes from a single template that cannot drift per domain.

**Simple domains**: Most admin/reference domains (accounts, agencies,
roles, etc.) register only search + get with direct `server.registerTool()`
calls.

**JSON:API body builder**: `buildJsonApiBody(type, attributes, id?, relationships?)` in
crud-factory.ts builds the `{ data: { type, attributes, relationships? } }` payload.
Filters out undefined values; a relationship set to `undefined` is omitted, one set to
`null` is sent as `{ data: null }`, which **clears** the link (provider invoices' `provider: null`).

## Tool Naming Convention

All tool names follow: `boond_{domain}_{operation}`

- Operations: `search`, `get`, `create`, `update`, `delete`
- Tab tools: `boond_{entity}_{tab_name}` (e.g., `boond_resources_technical_data`)
- Reporting: `boond_reporting_{type}` (e.g., `boond_reporting_companies`)
- Application: `boond_application_dictionary`, `boond_application_current_user`

## MCP Annotations

Every tool must declare annotations:

- `readOnlyHint: true` for search/get operations
- `destructiveHint: true` for delete operations
- `idempotentHint: true` for search/get/update operations
- `openWorldHint: true` for search operations (paginated, keyword-filtered)

Prompts and resources don't take annotations — `title` and `description`
are what the client surfaces.

The access-control layer (below) classifies each tool's *operation* from
these annotations, so they double as the source of truth for read-only /
write / delete filtering. Keep them accurate.

## Structured Outputs (outputSchema / structuredContent)

The crud-factory tools declare an MCP `outputSchema` and return
`structuredContent` alongside the text:

- **search** (`SearchOutputSchema`): `{ total?, count, items: [{ id, type, summary | attributes }] }`.
  Deliberately compact — `summary` is the same one-liner as the text output,
  or `attributes` when the caller passed `fields`. Never the full JSON:API
  resources (that would defeat the token economy).
- **create / update** (`MutationOutputSchema`): `{ id?, type? }` — reliable
  entity reference for chaining.
- **delete** (`DeleteOutputSchema`): `{ id, deleted, reason? }`.
- **get / detail tools have no outputSchema on purpose**: their text already
  is the machine-parseable JSON; duplicating it as structuredContent would
  double the payload.

## Delete Confirmation (MCP elicitation)

Every `boond_*_delete` tool asks the end user for confirmation through MCP
elicitation (spec 2025-11-25) **when the client declares the `elicitation`
capability** — implemented in `crud-factory.ts::confirmDeletion()` (also used
by the non-factory delete in `resources.ts`). Clients without the capability —
and failed elicitation round-trips — keep the legacy direct-delete behaviour.
Opt-out: `BOOND_MCP_CONFIRM_DELETE=0|false|no|off` (exposed as the
`confirm_delete` toggle in `manifest.json::user_config`).

The requested schema is a **titled single-select enum with a default**
(SEP-1330 / SEP-1034), not the boolean it used to be:

```json
{ "confirmation": { "type": "string", "default": "cancel",
  "oneOf": [ { "const": "delete", "title": "Supprimer définitivement" },
             { "const": "cancel", "title": "Annuler" } ] } }
```

Invariants, each with a test:

- the **safe** answer is the pre-selected one, and the consequence is in the
  option label (a checkbox "Confirmer la suppression" is mis-clickable and
  pre-checked by some hosts);
- `required` is deliberately **absent**: the SDK validates the response against
  this schema with Ajv, and a rejection *throws* — which would land in the
  `catch` that falls back to deleting. Lenient schema, strict interpretation;
- the SDK still Ajv-validates the answer against the `oneOf`, so a rejection is
  possible anyway (a host that renders the titled enum as a free-text field, a
  user typing "annuler"). `isElicitationResponseRejected()` peels that specific
  failure — `McpError(InvalidParams)`, or `InternalError` from the validator
  itself — out of the fallback and treats it as a **refusal**
  (`reason: "invalid-confirmation-response"`). An off-schema answer is not a
  broken round-trip, and deleting on an explicit "no" is irreversible;
- interpretation is strict in the safe direction: only `confirmation:
  "delete"` (or the legacy `confirm: true`, still honoured) deletes. Anything
  else — `cancel`, an unknown value, an empty `content` — aborts with
  `deleted: false` + reason;
- only capability-absence and *transport* failures fall back to deleting.
