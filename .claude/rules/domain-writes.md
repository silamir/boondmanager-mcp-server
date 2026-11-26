---
paths:
  - "src/schemas/**/*.ts"
  - "src/tools/validations.ts"
  - "src/tools/alerts.ts"
  - "src/tools/inactivities.ts"
  - "src/tools/forms.ts"
  - "src/tools/groupments.ts"
  - "src/tools/flags.ts"
  - "src/tools/tasks.ts"
  - "src/tools/todolists.ts"
  - "src/tools/advantages.ts"
  - "src/tools/absences.ts"
  - "src/tools/rights.ts"
  - "src/tools/find.ts"
  - "src/tools/contracts.ts"
  - "src/tools/deliveries.ts"
  - "src/tools/payments.ts"
  - "src/tools/provider-invoices.ts"
  - "src/tools/purchases.ts"
  - "src/tools/application.ts"
---

# Domain write paths and their verification status (validations, alerts, flags, contracts, finance updates, find, rights)

<!-- Moved verbatim from CLAUDE.md; loaded only when Claude works on the files above. -->

**Validations** (`src/tools/validations.ts`, issue #251): the validation
workflow of a CRA / expense report / absence request is the one write the
documents themselves do not accept (`state` is absent from their write
schemas, #250). `boond_validations_update(id, decision: validate | reject,
reason?)` sends `PUT /validations/{id}` with `state: validated | rejected` —
the vocabulary `validationStates` enumerates in the RAML — and `reason`,
built from `models.validation` (`state`, `reason`, `date`, `expectedValidator`,
`realValidator`, `dependsOn`). **No RAML documents the write and the route
has not been exercised** (production tenant): a 404 / 405 is surfaced as is,
and the first call against a test tenant should confirm the verb and fix
this paragraph. A rejection goes through `confirmChoice()` — the elicitation
mechanics of `confirmDeletion`, generalised (same titled enum, same
safe-by-default `cancel`, same wire value so old clients keep answering) —
unless `BOOND_MCP_CONFIRM_REJECT=0|false|no|off`. `structuredContent` carries
`{ id, decided, state, documentType, documentId }`, the document coming from
the response's `dependsOn`. The `id` is the **validation's**, listed by
`boond_validations_search`, not the report's.

**Alerts** (issue #255, domain `alerts`, 42 in total; semantics fixed
by #311 after the live read): `GET /alerts` returns the **configuration** of the
user's dashboard indicators, not computed occurrences — one row per indicator
(`module`: `actions` | `activityExpenses` | `resources`…; `indicator`:
`contractsEndedUpcoming`, `resourcesProbationaryDateUpcoming`,
`timesReportsWithNoValidation`, `actionsUpcoming`…) with `params.period`
(days, `-1` = last month), `X` / `Y` (state or type ids) and `perimeter`
(`dynamic_data`); no `/alerts/{id}` (404), no filter, no pagination. So the
list says *what* to watch with which thresholds, and the matching `*_search`
gives the items — `boond_alerts_search` (only the client-side `fields`), the
resource `boond://alerts/me` (same rows as JSON, domain-gated,
`MAX_RESOURCE_BYTES` by dropping rows past 200 into `_omitted`) and the
prompt `attention_du_jour` (indicator → search with its thresholds → triage)
all say so. `alertSummary` renders `period=… X=[…] perimeter=…`. The domain
is in every profile.

**Inactivities, forms, groupments** (issue #256, three new domains, 41 in
total): all three collections document `post` only (no list GET) plus
`default` and `rights`, so each domain gets `_default` (`GET
/{collection}/default?resource=|template=&resource=|project=`), `_get` and
`_create`, groupments also `_update` (`PUT /groupments/{id}`, base resource
like #252). Bodies from `models.inactivity` / `models.form` /
`models.groupment` — **not exercised** (production tenant; BoondManager in
maintenance when written). `form` joins `TASK_ENTITIES` (`forms/tasks.raml`).
Profiles: `delivery` gets the three, `recruiting` gets `forms`. The API
monitor's `EXTRA_DOMAINS` now probes `quotations`, `kilometricExpenses`,
`targets`, `workflows`, `warnings`, `savedSearches`, `tasks` and
`attachedFlags` (the last two answer 200 on the doc site already), so the
next weekly run settles the audit's hypotheses instead of us guessing —
`quotations` in particular has **no** RAML today, which is why there is no
quotations domain. Occupation rate: no inactivity list exists, use
`boond_reporting_resources`.

**Flags, tasks, todolists, advantages writes** (issue #254): what the RAML
documents is narrower than the ticket assumed, and the tools follow the
RAML. Documented and exposed: `POST /flags` (`boond_flags_create`, from
`models.flag`), `POST` / `DELETE /attached-flags` (`boond_flags_attach` —
body `{ relationships: { flag, dependsOn } }`, the polymorphic pattern of
`models.task` — and `boond_flags_detach`, whose query parameters `flag` +
`<entity>` **are** documented), `GET /{entity}/{id}/attached-flags` on 11
entities (`boond_flags_attached`), `GET /{entity}/{id}/tasks` on 14 entities
(`boond_tasks_get`, one parameterised tool rather than 14 tabs), `POST
/todolists` (`boond_todolists_create`, from `models.todolist`),
`GET /advantages/default` and `POST /advantages` (`boond_advantages_default`,
`boond_advantages_create`, from `models.advantage`). **Not exposed because
undocumented**: task creation (`tasks.raml` only has `get`, no `/tasks`
collection — 404 on the doc site) and thread creation (`POST /threads` is
documented but `models.thread` is empty, so the body is unknowable). None of
the POST bodies was exercised (production tenant): the first 422 on a test
tenant names the missing attribute, fix the schema then.

**`default` and `rights` endpoints** (issue #257): `boond_absences_default`
(`GET /absences-reports/default?resource=&agency=`) joins
`boond_expenses_default` and `boond_timesheets_default` as the only place the
absence type codes (`workUnitTypeReference`) are published — on the included
resource's `workUnitTypesAllowed`, production types filtered out;
`AbsenceCreateSchema.workUnitTypeReference` points at it. Its rendering was
confirmed live on 2026-09-26 (#311): the included resource carries
`workUnitTypesAllowed` and the seven absence types of the agency come out
with their `reference` (3 sans solde, 4 RTT, 5 maladie, …), production types
filtered.
`boond_rights_get(entity, id)` (`src/tools/rights.ts`, registered by
`registerApplicationTools`, enum narrowed by the access policy) reads
`GET /{collection}/{id}/rights` for the 21 entities whose `rights.raml`
exists and renders the payload as-is. Observed live (#311): `{ id:
"resource_18081", type: "rights", attributes: { actions: { share, addAbsence,
sendClientMail, … }, apis: { entity: { read, write }, information: { read,
write }, actions: {…}, attachedFlags: {…}, … } } }` — `apis.<tab>.write` is
the flag to check before a `*_update`, `actions.*` the workflow actions.
The update / delete templates mention it (`rightsHint`) for those prefixes
only.

**`boond_find`** (`src/tools/find.ts`, issue #262): name / e-mail → id for
the six main entities, registered by `registerApplicationTools` (the
`application` domain is in every profile) with the entity enum narrowed to the
domains the access policy allows — absent when none is. It owns the sequence
the prompts' `resolveEntity` used to describe: per entity the field to search
(`fullName` in **both** word orders — the API wants `NOM#PRENOM` and users type
either —, then free text; `name` on companies; `emails` when `email` is
given), `pageSize: 10`, first attempt with rows wins. Two invariants, both
tested: **several exact matches are an `isError`** with the list (never a
silent first-row pick), and a result set with no exact match comes back
without `match` so the model confirms before using an id. The `_get` /
`_update` templates name it (`findHint`) for those six prefixes only.

**Contracts** (`src/tools/contracts.ts`, issue #253): BoondManager has **no
contract list**. Probed live on 2026-09-26: `GET /contracts` answers the WAF's
403 HTML page (the RAML only documents `post`), `GET /resources/{id}/contracts`
404s. The only read path is `/resources/{id}/administrative`, whose `included`
carries the full contract objects — and the tab renderer drops `included`, so
`boond_resources_administrative` used to show only the ids. Hence two tools:
`boond_resources_contracts` (a *virtual* tab: administrative → included
contracts, one line each via `contractSummary`) and `boond_contracts_search`,
a **composed** search — resource filters (`keywords`, `perimeter*`,
`resourceStates`, `page` / `pageSize`) select the resources, then one
administrative read per resource (4 in flight, progress notified), then
`contractTypes` / `period` (`running` | `ending` | `starting` |
`probationEnding`) + `startDate` / `endDate` are applied server-side
(`filterContracts`; a contract without `endDate` is open-ended). Its
`resourceId` is a short-circuit (read that resource only), **not** a
`keywords` reference. The `alertes_contrats` prompt chains both windows. Add
`GET /contracts` back the day the API grows one — the composed search is a
workaround, priced at N+1 calls.

**Update / delete on the finance & delivery entities** (issue #252):
`boond_{contracts,deliveries,payments,provider_invoices,purchases}_update`
and `boond_{deliveries,payments,provider_invoices}_delete` go through the
factory. Routes: `PUT /purchases/{id}/information` is documented
(`purchases/information.raml`); contracts, deliveries, payments and provider
invoices have **no** `information.raml` on the doc site (404, checked
2026-09-26), so they PUT the base resource — the pattern `/actions/{id}` and
`/times-reports/{id}` follow. **None of these five write paths has been
exercised** (production tenant): the schemas are attribute-only
(`models.<entity>` in the dictionary), never move a relationship (except the
provider-invoice `provider`, below), and their
`state` is `stateField` (rows in `state-writability.test.ts`). The first
write against a test tenant should confirm the verb (a 405 means
`/information` is expected) and fix this paragraph. `note` maps to
`informationComments` on contracts and purchases — `models.contract` /
`models.purchase` have no `note`, so the create tools were sending an
attribute the API ignored.

**Provider invoices: supplier and resource.** The RAML's
`providerInvoices/bodyPut.json` documents `providerCompany` and
`providerContact` on `PUT /provider-invoices/{id}`, each nullable, each
"have to be set" once the other is — hence the update schema's single
`provider: { companyId, contactId } | null`. It documents **no `resource`**
(only `bodyPost.json` and the read `profile.json` carry it), so the resource of
an invoice (an e-invoice received without one) cannot be set through the
public API as documented; the update description says so. Not exercised: the
`provider` write, and whether an undocumented `relationships.resource` on PUT
is applied or silently ignored — try both on a sandbox, then fix this
paragraph. List rows (60 read live, 2026-11-26) carry `vatNumber` and, when
set, `resource`; none carried `providerCompany`, which is why the search
summary shows the VAT number and not the supplier's name.

**Order correlations (`deliveriesPurchases`)**: the deliveries and purchases
ticked in the UI's "Prestations / Achats corrélés" block. `GET /orders/{id}`
does not carry them (its RAML relationships are `project` and `mainManager`
only); `GET /orders/{id}/information` does, as
`relationships.deliveriesPurchases.data = [{ id, type: "delivery" | "purchase" }]`,
with every delivery and purchase of the project in `included` (the checkbox
list) and their resources for the names. Read verified on a production
tenant (2026-11-26). `boond_orders_get` therefore makes a second call to
`/information` and renders the section (`formatCorrelatedDeliveriesPurchases`).
Writes: `relationships.deliveriesPurchases` on `POST /orders` and
`PUT /orders/{id}/information` (RAML `orders/bodyPost.json`,
`orders/informationBodyPut.json`, `uniqueItems`), sent by `buildOrderBody`
with duplicates dropped. **Not exercised**: whether the array replaces the
existing list (assumed, like every JSON:API to-many relationship and like
`actualExpenses`), whether an empty array un-correlates everything, and which
422 an item from another project returns. Reported, not verified on a sandbox: correlating a delivery that starts before
the order moves the order's `startDate` back (and un-correlating it restores
it), as if BoondManager widened the order's period to cover its correlated
deliveries; the create / update descriptions tell the model to read the order
back. The RAML also documents a `forceDate` boolean on orders
(`TAB_BONDECOMMANDE.BDC_FORCE_DATE`) on POST and on `PUT /orders/{id}/information`,
not exposed and not exercised. Its RAML also lists it in the
`GET /orders/{id}/information` response, but a live read does not return it
(nor `GET /orders/{id}`, nor `GET /orders/default`): there is no way to read it.
Confirm on a sandbox and fix this
paragraph.
