---
paths:
  - "src/tools/**/*.ts"
  - "src/instructions.ts"
  - "scripts/measure-tools-list.mjs"
---

# Tool description contract

<!-- Moved verbatim from CLAUDE.md; loaded only when Claude works on the files above. -->

## Tool Description Contract

Every advertised tool description states four things, in this order: **purpose**
(verb + resource + scope, one sentence), **usage guidance** (`Quand :` /
`Plutôt que :`, naming a real sibling), any **behaviour** a caller cannot infer
from the schema, and **`Returns :`**. Composed by
`src/tools/description-builders.ts` and asserted end-to-end over a real client
in `src/tools/descriptions.test.ts` (`advertised tool descriptions`).

Why it is a contract and not a style guide: the catalogue is 182 tools, ~45 of
which take a bare `id` and return "some fields of one entity". A description
that only says what the tool does leaves a model choosing between them by name
similarity. The measured state before this contract: **181 of 182** tools said
nothing about which sibling to prefer, the median description was 170 chars, and
30 tools sat under 75 — `boond_actions_get` was *"Récupère les détails d'une
action par son ID."*, which restates its own name.

Where descriptions come from, in order of coverage:

1. **The five CRUD templates + the tab template** (`description-builders.ts`)
   — ~145 tools. Fixing a template fixes every domain at once, which is also
   what keeps siblings phrased consistently.
2. **Central disclosures** (`parameter-disclosure.ts`, `usage-guidance.ts`),
   applied by the `registerTool` Proxy in `registration-decorators.ts` — same
   mechanism and same rationale as the filter hints: a rule that has to be
   remembered in 38 files is a rule that decays.
3. **Hand-written bodies** in the domain files, for endpoint filter vocabulary
   and the documented traps (expenses, documents, technical data). The
   guidance section is backfilled around them, never over them — a
   hand-written explanation always wins.

### Invariants (each has a test)

- **No `Args:` block that paraphrases the schema.** The client already received
  the JSON Schema with its `.describe()`-d properties; restating it costs bytes
  and adds nothing — and it *drifts*: `boond_payments_search` documented an
  `invoiceId` the schema no longer accepted, `boond_application_dictionary`'s
  schema still advertised the slash form its own description called invalid.
  The templates dropped theirs first; since issue #241 the rule is asserted on
  the **advertised** descriptions (`Args:` / `Arguments :` / `Paramètres :`, real
  client), so a hand-written body cannot reintroduce one. An endpoint trap that
  used to live in such a block (`/actions` create wants exactly one `dependsOn`
  id, `*Id` search filters become `keywords` references) is now a behaviour
  sentence, or the field's own `.describe()`.
- **`fields` and `page`/`pageSize` are disclosed wherever the schema accepts
  them** — 32 and 38 tools. Both carry semantics a JSON Schema cannot express:
  `fields` is applied *client-side* and never forwarded to BoondManager, and
  the page ceiling **rejects** rather than clamps. This is the whole defect that
  made `boond_poles_search` and `boond_accounts_search` the catalogue's
  worst-described tools.
- **Four reference routes ignore `maxResults` and say so.** `/poles`,
  `/agencies`, `/calendars` and `/webhooks` answer `maxResults=2` with their
  whole table (73, 11, 249 and 3 rows — verified against the live API on
  2026-09-09; the server does send the parameter, BoondManager discards it).
  They are listed in `TOOLS_IGNORING_PAGINATION` (`constants.ts`) and get
  `PAGINATION_INERT_DISCLOSURE` instead of the ceiling. This is why the
  pagination sentence is single-sourced in `withParameterDisclosure` and
  **not** hard-coded in `defaultSearchDescription`: the correct wording depends
  on the route, and a template that stated the ceiling would both make a false
  promise and suppress the right sentence (by having already mentioned
  `pageSize`). Not an operational risk — these are small tables, ~18 KB of tool
  result at the largest, far under `CHARACTER_LIMIT`. Add a route only once it
  has been *observed* returning more rows than it was asked for;
  `/business-units`, `/products`, `/threads` and `/todolists` were empty on the
  tenant probed, so their behaviour is unknown and they are deliberately absent.
- **Descriptions never contradict the ceilings the schemas enforce.** The
  previous hand-typed template announced `pageSize (défaut: 20, max: 100)`
  against a schema enforcing `DEFAULT_PAGE_SIZE`/`MAX_PAGE_SIZE` (30/500) and
  shipped that to 11 domains. The disclosures interpolate `constants.ts`, and a
  test flags any literal that disagrees — plus a second test proving that guard
  actually catches the historical string, so it cannot pass vacuously.
- **`USAGE_GUIDANCE` cannot rot silently.** It is keyed by tool name, so both
  directions are asserted: no entry may name a tool that does not exist, and no
  tool may end up without guidance.
- **An `instead` names a tool or says none exists.** "See the other tools"
  costs bytes and resolves no ambiguity; where a tool is genuinely the only
  path (`boond_expenses_default`, `boond_documents_create`), saying *that* is
  the actionable fact.

### Length limits (`src/tools/descriptions.test.ts`)

- **Tools**: 250–2400 chars. The **floor** is the load-bearing half — it is
  what stops a new domain from landing another 50-char stub. The ceiling was
  raised from 2000 when guidance and `Returns` became mandatory:
  `boond_resources_search`, the widest filter vocabulary in the catalogue,
  lands at 2149, and the cap's job is to stop essays, not to force a choice
  between documenting filters and documenting siblings.
- **Prompts**: 3000 chars — user-facing templates, but not essays.
- **Resources**: 1000 chars — metadata for the list, not the content.

### The cost, stated plainly

`tools/list` went from **292 KiB to 359 KiB** (+23%). That is the deliberate
trade: the descriptions are the thing a model reads to pick a tool, and 48 KiB
of them across 182 tools was not enough to pick correctly. Two notes on it:

- It partly **duplicates `SERVER_INSTRUCTIONS`**, which states the `fields` and
  pagination rules once for the session precisely to avoid paying them 182
  times. That duplication is intentional here and only here: a client that
  lists tools without reading `instructions` — and any tool-definition
  scorer — sees each tool in isolation. Both disclosures are therefore kept at
  the shortest form that still carries the fact, with a test capping their
  length, because every word is paid 32–38 times.
- Operators who need the payload smaller have the existing levers:
  `BOOND_MCP_PROFILE` / `BOOND_MCP_DOMAINS` cut the surface, and
  `BOOND_MCP_ICONS=0` drops another 40 KiB.
