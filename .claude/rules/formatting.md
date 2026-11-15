---
paths:
  - "src/services/format/**/*.ts"
---

# Output formatting: list summaries, truncation

<!-- Moved verbatim from CLAUDE.md; loaded only when Claude works on the files above. -->

**List summaries** (`src/services/format/summary.ts::formatEntitySummary`): one
line per search result. A tool whose rows need a bespoke line hands
`formatListResponse` its own `summaryFn` (4th argument — `timesheetSummary`
in `src/tools/timesheets.ts`, issue #243) rather than growing a private
formatter: the private one cut mid-line without a count and crashed on
`data: null`, which is also why `formatListResponse` now treats a null `data`
as an empty page. Rows are normally identified by name / `value` /
`title`. Rows that have none of those — `/invoices`, `/orders`, `/actions`,
`/deliveries-groupments`, `/projects` are keyed on a reference, a number or a
date — fall back to `fallbackIdentityParts()`, which appends `number`,
`reference`, the date (or `startDate`→`endDate` window), up to
`MAX_FALLBACK_AMOUNTS` turnover figures, `typeOf`, and a `Note: "…"` excerpt of
`text`. The fallback is **conditional on purpose**: `/resources` and
`/opportunities` also carry `reference` and amount attributes, and appending
them there would inflate every line for no gain. When touching this, keep the
regression tests in `format/summary.test.ts` that pin the named-row output
byte-for-byte.

Invariants the excerpt path must keep (each has a test):

- `text` is excerpted **only when it is a string** — `text: null` / nested
  objects must not print `null` / `[object Object]`.
- The note is **labelled and quoted** (`Note: "…"`): it is end-user CRM prose,
  so the model has to read it as a data field, not as server-authored text.
- Tags are stripped with `HTML_TAG_RE` (tag name required after `<`, quoted
  attribute values matched explicitly), never `/<[^>]*>/` — that regex ate user
  text between a `<` and a later `>`. Entities are decoded (`decodeHtmlEntities`).
- Truncation runs on code points (`Array.from`), so an emoji on the
  `MAX_TEXT_EXCERPT` boundary can't become an unpaired surrogate.
- Attribute values go through the shared `renderAttributeValue()` — the same
  helper `formatProjectedSummary` uses, so object-shaped amounts render
  identically on both paths.

**List truncation** (`formatListResponse`): a page over `CHARACTER_LIMIT` is cut
**on line boundaries** and ends with `[Résultats tronqués : shown/total
ligne(s) affichée(s) …]`. Enriched fallback rows are several times longer than
the bare `[type #id] | Statut: n` they replaced, so a 500-row `/actions` page
can now hit the limit; a mid-line cut used to emit a half-row that looked
complete and hid the row count from the model. The result is always
≤ `CHARACTER_LIMIT`.
