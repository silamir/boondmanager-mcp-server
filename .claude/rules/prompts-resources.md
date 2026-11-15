---
paths:
  - "src/prompts/**/*.ts"
  - "src/resources/**/*.ts"
  - "src/services/dictionary.ts"
---

# Prompts, resources, dictionary cache, entity templates

<!-- Moved verbatim from CLAUDE.md; loaded only when Claude works on the files above. -->

**Prompts** (`src/prompts/index.ts`): pre-orchestrated workflows that
resolve to a `user` message guiding the model through a fixed tool
sequence with the correct filter names. Server-side we *only* assemble
the runbook — the LLM still drives the calls. Relative periods
("cette semaine", "avril 2026", `2026-W14`, "D → D+H") are resolved to
literal ISO dates **on the server** by `src/prompts/periods.ts`
(issue #260) — `build(args, now?)` takes the reference date so tests pin the
week and year boundaries; unknown wording keeps the caller's words and states
today's date. `*_id` arguments carry a `completions/complete` completer
(`completable()` from the SDK) that searches the entity and returns
*labels* — the arguments accept labels, and `CompleteResult.values` is
substituted verbatim. The mirror `boond_workflow_*` tools are unaffected:
`completable()` attaches a non-enumerable symbol to the same Zod object. Includes
`synthese_equipe`, `pipeline_commercial`, `factures_a_relancer`,
`candidats_pour_opportunite`, `fiche_consultant`, `recap_hebdo`,
`traiter_note_de_frais`, and since issue #259 the eight ESN routines
`relance_cra`, `absences_a_valider`, `marge_projet`, `preparation_entretien`,
`preparation_rdv_client`, `relance_devis`, `purge_rgpd_candidats`,
`preparation_facturation`, and `ingest_communication` (issue #180: pasted
e-mail / call notes → contact, company, action; dedup through `boond_find`
by e-mail, then a plan the user validates before any write; no Sampling —
the model extracts, the server only supplies the runbook) — the full list
lives in `TOOLS.md`. Shared
helpers: `managerScope()` (explicit `perimeterManagers` or the caller's N-1),
`MONTH_ARG` / `MANAGER_ARG`, `positiveInt()`; `resolveEntity` knows the
`candidate` and `contact` kinds. A prompt only survives a profile when **all**
its domains are in it, which is why #259 added `invoices` to `sales`,
`timesheets` + `deliveries` to `finance` and `contracts` to `delivery` — check
`docs/access-control.md` (profile table) when adding one.

**Resources** (`src/resources/index.ts`): static MCP resources for the
curated set of dictionaries the search tools depend on
(`boond://dictionary/states/*`, `boond://dictionary/typeOf/*`,
`boond://dictionary/actions/*` — action types are declared *per attached
entity*, `setting.action.<entity>` —, `sources`, `origins`, `paymentMethods`,
`paymentTerms`, `taxRates`, `contractEndReasons`,
`boond://dictionary/{countries,currencies,languages}`) plus the convenience
`boond://application/current-user` and its condensed
`boond://application/current-user/rights` (level, agencies / poles / BU, apps,
and per entity the `creation` / `deletion` authorisations and the *active*
search-perimeter flags — `buildCurrentUserRights()`; the raw payload carries
~100 KB of field-level detail nobody reads). Lets the model translate
state/typeOf integers to labels via a resource read instead of a tool
call. Arbitrary dictionary types still go through the
`boond_application_dictionary` tool. Every `DICTIONARIES` path was verified
against the live dictionary (issue #261, 2026-09-26); the ones the API does
**not** publish are named in the source next to the table — `states/contracts`,
`states/validations` (workflow strings, #250), absence types
(`/absences-reports/default`, #257),
`typeOf/{candidates,opportunities,companies}` — so nobody adds a slug that
resolves to the "path not found" body.

**Dictionary cache** (`src/services/dictionary.ts`, issue #226): the
`/application/dictionary` payload is cached in memory, but it is **not a global
reference table** — it carries a tenant's custom states, agencies, poles and
types. The cache is therefore keyed by `(auth identity, language)`:
`sha256(Bearer token)` under the HTTP OAuth transport (every request may belong
to a different tenant, and the transport only checks that a Bearer is
*present*), a constant `env` identity on stdio / static auth. A single
process-wide entry used to hand the first caller's dictionary to every later
caller without an API call — a cross-tenant leak — and `inFlight` ignored the
language, so an `en` request could receive the `fr` payload still loading.
Both `cache` and `inFlight` are now `Map`s on that key, LRU-bounded at
`MAX_DICTIONARY_CACHE_ENTRIES` (50). Each property has a test in
`dictionary.test.ts`.

**Entity resource templates** (`src/resources/templates.ts`, issue #177): six
parameterised resources — `boond://{candidate,resource,contact,company,opportunity,project}/{id}`
— returning the base record plus its cheap tabs (`information`, and
`technical-data` on people) in **one** `resources/read` where the tool path
costs 2–3 round-trips. `ResourceTemplate` is native in SDK 1.30, so unlike
icons there is no shim; `templates/list` even spreads the metadata, so `icons`
reaches the client on its own.

Invariants, each with a test in `templates.test.ts`:

- **The template is deliberately not enumerable** (`list: undefined`, a key the
  SDK requires you to state). It therefore never appears in `resources/list`,
  which is also why it does **not** feed Claude Desktop's `@` picker — that
  selector reads `resources/list`. Enumerating would paginate the whole Boond
  database into every listing, on every connection. Assisted entry is
  `completions/complete` instead (`complete: { id }` → the domain's `*_search`),
  and it returns **ids only**: `CompleteResult.completion.values` is a
  `string[]` substituted verbatim into the URI variable, so there is no channel
  for a human-readable label.
- **`{id}` must be validated in the handler.** The SDK compiles `{id}` to RFC
  6570's default `([^/,]+)`, *not* to a numeric pattern, so
  `boond://candidate/1?x=2`, `…/1#f` and `…/..%2Fresources%2F9` all match the
  template and arrive as `variables.id` — from where they would be interpolated
  into an API path. `EntityIdSchema` is the wall; same class of hole as the
  document-id guard (#186).
- **The body is always parseable JSON.** `MAX_RESOURCE_BYTES` (256 KiB) is
  enforced by dropping whole sections and naming them in `_omitted`, never by
  cutting the serialised text — a resource has no `pageSize`, but handing back
  truncated JSON breaks the one thing `application/json` promises. This is why
  the templates reuse `projectEntity` (extracted from `formatDetailResponse`)
  rather than `formatDetailResponse` itself, which truncates mid-string.
- **A failing tab keeps the record** (`Promise.allSettled` → `_errors`); a
  failing base record propagates, because a shell of empty tabs reads as "this
  entity exists and is blank".
- **Only bounded tabs are aggregated.** `actions`, `positionings`, `invoices`,
  `times-reports` stay tools: a resource is read whole or not at all, so
  folding 200 actions in would make the read size unpredictable.
- **URIs are singular while dictionary slugs are plural** (`boond://candidate/{id}`
  vs `boond://dictionary/states/candidates`). A template names one entity, a
  dictionary names a collection of labels. Both are published URIs — do not
  align either on the other.
