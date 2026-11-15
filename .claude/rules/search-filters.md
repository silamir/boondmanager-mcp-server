---
paths:
  - "src/schemas/**/*.ts"
  - "src/tools/**/*.ts"
  - "src/prompts/**/*.ts"
  - "src/services/search.ts"
  - "src/constants.ts"
---

# Search filters, pagination ceilings, self-correcting rejections

<!-- Moved verbatim from CLAUDE.md; loaded only when Claude works on the files above. -->

## Search Filter Naming (CRITICAL)

The six search tools (resources, candidates, contacts, companies,
opportunities, projects) accept input field names that **must match the
official BoondManager API query parameter names exactly** — the schema
input keys are forwarded verbatim by `buildSearchQuery()`. Wrong names
are silently ignored by the API and return the unfiltered baseline. The
authoritative spec is the RAML at
`https://doc.boondmanager.com/api-externe/raml-build/`.

Common gotchas:

- **"Mes données / mon équipe / mon agence"** → `perimeterDynamic` (not `mainManagers`):
  - `perimeterDynamic: ["data"]` — my own data
  - `perimeterDynamic: ["managers"]` — my N-1
  - `perimeterDynamic: ["agencies" | "poles" | "businessUnits"]`
- **"Team of person X"** → `perimeterManagers: [<X_id>]` (not `mainManagers`)
- **Org perimeter** → `perimeterAgencies` / `perimeterPoles` / `perimeterBusinessUnits` (not `agencies` / `poles` / `businessUnits`); combine with `narrowPerimeter: true` for AND
- **States / types per endpoint** (integer IDs from
  `boond_application_dictionary`):
  - resources: `resourceStates`, `resourceTypes` (+ `excludeResourceStates`, `excludeResourceTypes`)
  - candidates: `candidateStates`, `candidateTypes`
  - opportunities: `opportunityStates`, `opportunityTypes`
  - projects: `projectStates`, `projectTypes`
  - contacts: `states`, `companyStates`, `typesOf` (with the `s`!)
  - companies: `states` only — no `typeOf` filter on `/companies` search
- **Linked entity** → `companies: [<id>]` (projects only, plural array) or
  the `keywords` prefix syntax: `CSOC<id>` (society), `CCON<id>` (contact),
  `CAND<id>` (candidate), `COMP<id>` (resource), `AO<id>` (opportunity),
  `PRJ<id>` (project), `MIS<id>` (delivery), `PROD<id>` (product),
  `CTR<id>` (contract). **No list endpoint has a `companyId` / `projectId` /
  `resourceId` query parameter** (issue #247, verified live on 2026-09-25:
  `GET /invoices?companyId=6221` returned all 29 893 rows, `keywords=CSOC6221`
  returned 2). The search schemas still expose those `*Id` fields because
  that is what a model reaches for, and every search handler — the
  crud-factory one and all hand-rolled ones — runs its params through
  `toKeywordReferences()` (`src/tools/linked-entity-filters.ts`), which moves
  them into `keywords` as prefixed references. Never forward a `*Id` search
  filter verbatim; `src/tools/linked-entity-filters.test.ts` asserts the
  query actually sent for every (tool, filter) pair. `boond_advantages_search`
  is the one list that is *not* a collection search: `GET /advantages` does
  not exist (WAF 403 page), the route is `GET /resources/{id}/advantages`, so
  `resourceId` is required there
- **Finance / activity searches take the same `perimeter*` filters** and
  their own state vocabulary (issue #248, every filter verified live on
  2026-09-26 by comparing `meta.totals.rows` with and without it):
  - invoices: `states` (`boond://dictionary/states/invoices`), `closed`,
    `creditNote`, `period: created|updated|expectedPayment|performedPayment|period`
  - orders: `states`, `customerAgreement`, `exceededOrderedTurnover`,
    `period: created|updated|period`
  - actions: `actionTypes` (`boond://dictionary/actions/<entity>` — declared
    per attached entity), `period: started|created|updated`
  - timesheets / absences: `validationStates` — **strings**
    `waitingForValidation|validated|rejected`, not ids (#250) —,
    `resourceTypes`, `closed` (timesheets); `startMonth` + `endMonth` required
  - deliveries (`/deliveries-groupments`): `deliveryStates`, `projectStates`,
    `projectTypes`, `transferType`, `period: started|stopped|updated|running|projectRunning`
  - payments: `paymentStates`, `paymentMethods`, `purchaseTypes`,
    `period: expected|performed|created|updated|createdPurchase|subscription|billing`
  - all seven: `periodDynamic` (`today`, `thisWeek`, `lastMonth`, `untilToday`…)
    instead of `startDate` / `endDate`, `flags`, `sort` / `order`.
  `ENDPOINT_FILTER_ALIASES` covers them too, so `states` on `/payments`
  answers "use `paymentStates`" and `states` on `/times-reports` answers
  "use `validationStates` (strings)".
- **Period vocabulary differs per endpoint**: e.g. `running` (projects),
  `closingDate` (opportunities), `available`/`working` (resources). See
  the per-endpoint description in `src/schemas/index.ts`.
- **`keywordsType`** lets the caller target a specific text field
  (`lastName`, `firstName`, `fullName` with `"NOM#PRENOM"`, `emails`,
  `phones`, `title`, `titleSkills`, …). Without it, the default scope
  is CV/full-text.
- Pagination: `pageSize` is the input name, mapped to `maxResults` for
  the API; `MAX_PAGE_SIZE = 500`, `DEFAULT_PAGE_SIZE = 30`.
- **`fields`** (every search tool except the `boond_reporting_*` family, which
  renders through its own formatters):
  client-side projection — the listed attribute names replace the standard
  one-line summary in the output. It is **never** forwarded to the API
  (`buildSearchQuery` strips it); unknown names are skipped silently. Use it
  to keep large result pages token-cheap (e.g. `fields: ["title", "updateDate"]`).
  Adding it to a new search schema means adding `fields: fieldsField` to the
  schema **and** passing `params.fields` to `formatListResponse` — the
  crud-factory does this automatically, hand-rolled tools do not
  (`src/tools/fields-projection.test.ts` asserts the forwarding for every
  hand-rolled search tool; add a row there for a new one).
  `fieldsField`'s description is deliberately terse: it is duplicated into ~32
  tool schemas, so each character costs ~32 bytes of the `tools/list` payload.
  Tools declaring an `outputSchema` must project through the same
  `entity.attributes ?? entity` bag as the text path (`buildListStructured`), or
  flat reference rows (`/calendars`, dictionary payloads) come back as bare ids.

### Shared schema shapes (issue #240)

`src/schemas/index.ts` composes the search schemas from exported shapes rather
than repeating fields: `perimeterShape` (the six RAML-trait `searchable`
filters), `paginationShape` (`page` / `pageSize` / `fields`),
`sortedPaginationShape` (+ `sort` / `order`), `shieldsField`,
`peopleKeywordsTypeEnum` (resources + candidates). Spread them
(`{ ...perimeterShape, ...sortedPaginationShape }`) — never redeclare `page`
with a bare `z.number().max(MAX_SEARCH_PAGE)`: ten schemas had done exactly
that and lost the self-correcting `MAX_SEARCH_PAGE` message `pageField`
carries. `src/tools/page-ceiling.test.ts` calls every tool that declares
`page` with `MAX_SEARCH_PAGE + 1` through a real client and fails by tool name
on a rejection that does not explain itself. Hand-rolled schemas in domain
files (`purchases.ts`, `provider-invoices.ts`) import `paginationShape` too.

### Rejections that carry their own correction (SEP-1303)

The Zod schemas in `src/schemas/index.ts` are `.strict()`, so a wrong filter
name is **rejected** instead of silently returning the unfiltered baseline. What
the caller gets back is not a bare "Unrecognized key" but the correction:

```
boond_resources_search { mainManagers: [42] }
→ isError: true
  Filtre inconnu « mainManagers » → utiliser `perimeterManagers` : IDs des
  managers dont on veut l'équipe (pour « mes données / mon équipe »,
  `perimeterDynamic: ["data"|"managers"]`).
  Filtres acceptés : keywords, keywordsType, perimeterManagers, …
```

How it is wired, and why it is wired that way:

- **`src/schemas/filter-aliases.ts`** holds the wrong-name → correction table
  (global + per-endpoint, since `states` means `resourceStates` on `/resources`
  and `candidateStates` on `/candidates`, and `/companies` has no type filter at
  all), plus a Levenshtein "did you mean" fallback for plain typos and the
  `boond://dictionary/*` URI to read when the value is a state/type id.
- **`src/tools/validation-wrapper.ts::withFilterHints()`** rebuilds a search
  tool's strict object schema with that message as its unrecognized-key error.
  It is applied centrally by `src/tools/registration-decorators.ts` (a
  per-domain `registerTool` Proxy installed in `registerAll`), so no domain file
  and no schema declaration has to know about it. "Search tool" is decided by
  `isSearchTool(name, config)`: `*_search` **or** `annotations.openWorldHint ===
  true` — the annotation is what the codebase reserves for paginated listing
  tools, so the `boond_reporting_*` family (same `perimeter*` / `*States`
  vocabulary, no `_search` suffix) is covered, and a future hand-rolled search
  tool can't opt out by being named differently.
- **A correction is only printed when this endpoint actually accepts the
  replacement** (`validKeys.includes(alias.correct)`). The alias table is written
  for the six perimeter-aware endpoints but the wrapper runs on every search
  tool: telling `boond_invoices_search` to use `perimeterAgencies`, which it does
  not accept, costs a second rejection and typically ends with the model dropping
  the filter and reporting a company-wide list as a scoped one. Per-key
  correction lines are capped (`MAX_UNKNOWN_KEYS_EXPLAINED`) with a
  "… et N autres" tail, and both alias tables are read through `Object.hasOwn` so
  a filter named `constructor` / `toString` can't resolve to an
  `Object.prototype` member.
- **It is a schema wrapper, not a handler wrapper, on purpose.** `McpServer`
  validates input *before* calling the handler, so a handler-level pre-parse can
  never run on a validation failure. The alternative — declaring a permissive
  schema and validating strictly ourselves — would drop
  `additionalProperties: false` from the advertised `inputSchema`, i.e. the very
  thing that lets a client pre-validate. Making the strict schema's own message
  the correction keeps both, and adds **no second parse** on the hot path.
- **SEP-1303 compliance already comes from the SDK**: it catches its own
  `McpError(InvalidParams)` and returns `isError: true` (`server/mcp.js`), so a
  validation failure is a *tool* error, not a protocol error. What was missing
  was a message worth self-correcting from. Both properties are pinned
  end-to-end through a real client in `src/server.test.ts`.
- Applied to search-shaped tools only (that is where the vocabulary is
  treacherous). Field-level messages are untouched — `page: 500` still answers
  with the `MAX_SEARCH_PAGE` explanation defined on `pageField`. Integer-id
  fields answer with the *right* resolution path: `intArray` (states, types,
  experience levels…) points at `boond://dictionary/*`, `entityIdArray`
  (`perimeter*`, `companies`, `flags`, `influencers`, `reporting*`…) points at the
  entity search tools instead — the dictionaries hold code tables, not entities,
  so sending the model there for `perimeterManagers: ["Jean Dupont"]` was a dead
  end.

## Search Pagination Limits

All search tools enforce a **maximum page number of 100** (configurable via `MAX_SEARCH_PAGE` in `src/constants.ts`). At 500 results/page, page 100 = 50,000 records — well beyond typical interactive exploration.

**Rationale:** MCP search tools are flagged `openWorldHint: true`, meaning the model can iterate indefinitely. Without a ceiling, a vague query can spiral into hundreds of pages before the model realizes the result set is too broad. The cap forces refinement (add filters, narrow perimeter) rather than brute-force pagination.

**Enforcement:** Zod schemas reject `page > MAX_SEARCH_PAGE` at input validation (before the API call). The model sees a clear schema error mentioning the limit, not a silent clamp or a cryptic API 400.

### Per-route `maxResults` ceiling (transparent chunking)

Some BoondManager routes cannot safely return large pages. `/actions` in particular overflows BoondManager's memory when `maxResults > 100` (their tech team reported internal alerts + a silent fallback to 30). To respect this **without** degrading usability, search tools do not go through `apiRequest` directly — they call `apiSearch(path, query)` (`src/services/boond-client.ts`).

- `ROUTE_MAX_RESULTS` in `src/constants.ts` maps an API path to its safe ceiling (`/actions` → 100). Routes absent from the map use `DEFAULT_MAX_RESULTS` (= `MAX_PAGE_SIZE`, 500).
- **Fast path:** when the requested `pageSize` is ≤ the route ceiling (every non-capped route, and small `/actions` requests), `apiSearch` makes a single `apiRequest` — byte-for-byte identical to before.
- **Chunked path:** when `pageSize` exceeds the ceiling (e.g. 500 on `/actions`), `apiSearch` fetches the requested window in chunks of `cap` records (each API call sends `maxResults = cap`, never more), merges the pages into one `JsonApiResponse`, and returns it. The caller still receives its full page "at once"; BoondManager never sees `maxResults` above the cap. Chunk count is bounded by `ceil((offset + requested) / cap)` and the loop stops early on a short page.
- To cap a future route, add one entry to `ROUTE_MAX_RESULTS`; no other code changes needed. Search-tool `pageSize` stays uniformly capped at `MAX_PAGE_SIZE`.
