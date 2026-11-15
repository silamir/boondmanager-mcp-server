---
name: add-tool
description: Checklist for adding a tool domain, a prompt or a resource to the BoondManager MCP server — the registration steps, the generated files and the catalogue guards that fail CI when one is forgotten.
---

The rules under `.claude/rules/` (tool factory, description contract, search filters,
testing) load as soon as you open the files involved; this is the order of operations.

## New domain (tool)

1. Create `src/tools/{domain}.ts` with a `register{Domain}Tools(server: McpServer)` function.
2. Simple search + get: direct `server.registerTool()` calls with `SearchSchema` / `IdSchema`.
   Full CRUD: the `crud-factory.ts` functions, with `overrides.schema` when the domain has
   structured filters.
3. Search schemas use the **exact** BoondManager query-parameter names, modelled on the RAML
   (`https://doc.boondmanager.com/api-externe/raml-build/resources/{domain}/search.raml`).
   Every id field is `EntityIdSchema` (or `DocumentIdSchema` for document ids), never a bare
   `z.string()` — `id-schemas.test.ts` fails otherwise.
4. Export from `src/tools/index.ts`, register in `src/server.ts` (`TOOL_REGISTRARS` order is
   API: append, don't reorder), add the API path to `API_PATHS` in `constants.ts`.
5. Write `src/tools/{domain}.test.ts` with a **handler** test (invoke the registered callback
   with a mocked `apiRequest` / `apiSearch`, assert path, method and body) — a
   registration-only suite fails the per-file coverage floor.
6. A hand-written description needs `Quand :` / `Plutôt que :` / `Returns :` or an entry in
   `USAGE_GUIDANCE`; `descriptions.test.ts` names the offending tool.
7. Decide which access profiles get the domain (`src/config/profiles.ts`) and recompute the
   tool / prompt counts of the profile table in `docs/access-control.md` (recipe under the
   table).

## New prompt

1. Append to `PROMPTS` in `src/prompts/index.ts`: `name`, `title`, `description`, `domains`,
   `argsSchema` (all `z.string()`), `build(args, now?)`.
2. Reference real tool names and the exact filter names; relative periods go through
   `src/prompts/periods.ts`.
3. Tests in `src/prompts/index.test.ts`. A prompt survives a profile only if **all** its
   domains are in it — check the profile table.

## New resource

- Curated dictionary: append to `DICTIONARIES` in `src/resources/index.ts` — only a path
  verified against the live dictionary.
- One-off: `server.registerResource(...)` in `registerAllResources`, `mimeType:
  "application/json"`, non-empty `title` + `description`, returns `{ contents: [{ uri,
  mimeType, text }] }`.
- Entity template: append to `ENTITY_TEMPLATES` in `src/resources/templates.ts`, bounded tabs
  only, `{id}` validated with `EntityIdSchema` before reaching an API path.
- Tests in `src/resources/index.test.ts` / `templates.test.ts`.

## Before the PR, in every case

- Update the counts sentence in `CLAUDE.md` (*Project Overview*) **and** in `README.md` —
  `src/catalogue-counts.test.ts` compares both with a real client.
- `npm run docs:tools` and commit `TOOLS.md` (regenerate after the final rebase).
- `npm test && npm run lint && npm run typecheck && npm run build`, and
  `node scripts/measure-tools-list.mjs` when tools were added (CI ceiling
  `MAX_TOOLS_LIST_KIB` in `ci.yml`).
- `CHANGELOG.md` `[Unreleased]` entry.
