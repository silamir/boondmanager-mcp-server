---
paths:
  - ".github/**"
  - "scripts/**"
  - "manifest.json"
  - "server.json"
  - "smithery.yaml"
  - "gemini-extension.json"
  - "plugins/**"
  - ".claude-plugin/**"
  - "Dockerfile"
  - "src/services/update-checker.ts"
  - "docs/distribution.md"
---

# Packaging channels, update notice and CI/CD

<!-- Moved verbatim from CLAUDE.md; loaded only when Claude works on the files above. -->

## Update Notification

The MCPB spec (`manifest_version: 0.3`) does **not** expose an `update_url` field, and Claude Desktop's auto-update mechanism only applies to extensions in Anthropic's curated directory. For third-party `.mcpb` installs, the closest practical equivalent is a startup notification: `src/services/update-checker.ts` queries `https://registry.npmjs.org/<pkg>/latest` (3 s timeout), parses the local `package.json` version, and — if a newer release exists — emits a structured `warn` log via the central pino logger (`event: "update_available"`). Claude Desktop captures stderr into its Developer log viewer, so the message is discoverable there; the user still downloads the new `.mcpb` manually from GitHub Releases.

Behavior notes:

- Fire-and-forget at startup in both stdio and HTTP transports — never blocks the server boot.
- Fails silently on network errors, non-2xx responses, malformed bodies, or unparseable semver; the server keeps running normally.
- Prerelease suffixes (`-rc.1`, `-beta`) are stripped before comparison (only the `X.Y.Z` core is compared).
- Opt-out: set `BOOND_DISABLE_UPDATE_CHECK=1` (or `true` / `yes`) to skip the check entirely. Useful for air-gapped or CI environments. Not exposed in `manifest.json::user_config` — MCPB users are precisely the audience the notification targets.
- Implementation deliberately uses only `package.json` (kept in the bundle — not listed in `.mcpbignore`) plus the npm registry; no GitHub API call, no rate-limit concerns.

## Claude Code Plugin Channel

The server ships as a Claude Code plugin so installation there is a form, not a
`claude mcp add` with three secrets pasted by hand:
`/plugin marketplace add silamir/boondmanager-mcp-server` →
`/plugin install boondmanager-mcp@boondmanager`. User-facing walkthrough in
`README.md`, channel contract in `docs/distribution.md`.

- **`manifest.json` stays the single source of truth.** Both plugin files are
  **generated** by `scripts/generate-plugin-manifest.mjs`
  (`npm run plugin:manifest`, CI-checked with `--check`). Two hand-written copies
  of the same 14 options would diverge on the first option added — the failure
  mode `TOOLS.md` has a drift check for. Every MCPB→plugin format difference
  lives in the generator: `user_config` → `userConfig` (the field is camelCase,
  the `${user_config.KEY}` *substitution* syntax is not), `display_name` →
  `displayName`, `repository` object → plain URL string, and MCPB-only keys
  (`manifest_version`, `server`, `icons`, `compatibility`, `support`,
  `tools_generated`) dropped. The generator also refuses to emit an option field
  it has no mapping for, rather than passing it through.
- **Launch mode is a pinned `npx`**, not a bundled build: the plugin copied into
  the user's cache is two small JSON files, and `boondmanager-mcp-server@X.Y.Z`
  is explicit and auditable. The pin only resolves *after* the release's npm
  publish, so it is bumped in the release commit and never ahead of it. It is the
  version copy that fossilises silently — a stale pin keeps installing an old
  release forever with nothing in the UI saying so — hence its own line in the CI
  version check.
- **stdio only.** The HTTP transport's OAuth model is for gateways and remote
  deployments; the plugin form has no way to obtain a Bearer token.
- **`sensitive: true` on the 5 credential options only.** Sensitive values go to
  the macOS Keychain, whose ~2 KB budget is *shared with Claude Code's OAuth
  tokens*; the access restrictions are not secrets and stay in `pluginConfigs`.
  Pinned in `src/config/packaged-installs.test.ts`.
- **Delete confirmation works here**: Claude Code declares the `elicitation`
  capability (it even exposes `Elicitation` / `ElicitationResult` hook events), so
  `confirmDeletion()` takes its normal path rather than the direct-delete
  fallback.
- Claude Code re-checks the reserved-marketplace-name list on **every** load, not
  only at `add` time, so a name drifting into that set breaks every existing
  install. `boondmanager` is deliberately not Anthropic-adjacent.
- Local schema validation: `claude plugin validate ./plugins/boondmanager-mcp`
  and `claude plugin validate .` (the latter validates the marketplace file).
  Not in CI — that would pull the whole `@anthropic-ai/claude-code` package into
  every run; the generator's own assertions plus
  `src/config/packaged-installs.test.ts` cover the same ground.

## CI/CD

- **CI** (`.github/workflows/ci.yml`): Runs on push/PR to main. Matrix: Node 22 + 24 + 26 (Node 20 dropped — EOL 2026-04-30). Steps: install, lint, typecheck, test:coverage, build, **MCPB validate** (Node 22 only), **TOOLS.md drift check** (Node 22 only), **Claude Code plugin drift check** (Node 22 only), **version consistency** across `package.json` / `manifest.json` / `server.json` / `gemini-extension.json` / `plugin.json` / `marketplace.json` / the plugin's `@X.Y.Z` npm pin / **both pins inside `server.json.packages[]`** (the npm `version` and the `v X.Y.Z` in the mcpb URL), coverage upload.
  Since issue #244, also on Node 22: **`format:check`** (five files had
  drifted because nothing ran it), **`npm audit --omit=dev --audit-level=high`**
  (runtime advisories only), plus two separate jobs — **`docker-build`**
  (buildx, no push, then a `/healthz` probe of the started container; before,
  the image was only built at release time) and **`tools-list-size`**
  (`scripts/measure-tools-list.mjs` spawns `dist/index.js` over stdio and
  measures the real `tools/list` bytes; fails above `MAX_TOOLS_LIST_KIB`
  (560 since #254 — 382 KiB at 185 tools, ~500 KiB at 233 tools on
  2026-09-26), builds the base branch and posts a sticky
  `<!-- tools-list-size -->` comment with the delta on same-repo PRs). Raise
  the ceiling in the PR that crosses it, with the reason in its description.
- **Smoke test (live)** (`.github/workflows/smoke-live.yml` +
  `scripts/smoke-live.mjs`): `workflow_dispatch` + nightly on weekdays, gated
  on the `BOOND_SANDBOX_*` secrets (absent → the job says "skipped" and stays
  green; never runs on PRs). **Read-only**: `current-user`, one `*_search` per
  domain with `pageSize: 1` (required months / dates / `resourceId` filled
  from context, other required args → skipped and listed), one `*_get`, and
  the #247 assertion that a `companyId` filter *reduces* `meta.totals.rows`
  on `/invoices` and `/orders`. Locally: `set -a; source .env; set +a; node
  scripts/smoke-live.mjs`. It is the only test that sees what the RAML does
  not say — its first run found that `GET /absences-reports` **requires**
  `startMonth` / `endMonth` (422 otherwise) while the schema declared them
  optional.
- **Release** (`.github/workflows/release.yml`): Triggered on `v*` tags. Publishes to:
  - **npm** with `--provenance --access public`
  - **GitHub Releases** with `.mcpb` bundle attached; release body extracted from the matching `## [X.Y.Z]` section of `CHANGELOG.md`
  - **MCP Registry** via `mcp-publisher` with GitHub OIDC
  - **GHCR** (`ghcr.io/silamir/boondmanager-mcp-server`) — multi-arch (`linux/amd64`+`linux/arm64`) with provenance + SBOM, tags `:X.Y.Z` `:X.Y` `:X` `:latest`
  - **Docker Hub** (`docker.io/{DOCKERHUB_USERNAME}/boondmanager-mcp-server`) — same multi-arch image, same tags. Gated on the `DOCKERHUB_TOKEN` repo secret being present, so forks without the secret skip Docker Hub without failing the release.
- **Docker publish (manual)** (`.github/workflows/docker-publish.yml`): `workflow_dispatch`-only. Inputs: `tag` (required), `ref` (optional git ref to build), `platforms`, `push_latest` (boolean). Pushes to GHCR + Docker Hub. Use for release candidates, feature-branch images, or ad-hoc re-publishes.
- **Qlty coverage** (`.github/workflows/qlty-coverage.yml`, issue #330): re-runs
  `npm run test:coverage` on Node 22 and publishes `coverage/lcov.info` to Qlty
  Cloud over OIDC (no secret). Reporting only — the gating thresholds stay in
  `vitest.config.ts` via `ci.yml`. Its file name is what the Silamir compliance
  bot checks (`qlty-coverage`), so don't fold it into `ci.yml`. Skipped on fork
  PRs: GitHub gives them no OIDC token, and the upload failed with
  `Unable to get ACTIONS_ID_TOKEN_REQUEST_URL`. Do not switch to
  `pull_request_target` to get one — it would run fork code with write access.
- **CodeQL** (`.github/workflows/codeql.yml`): static analysis for JS/TS and GitHub Actions.
- **Silamir compliance checks** (issue #355): the repository ruleset
  « Protection de main » requires five status checks — `Titre de PR`
  (`pr-title.yml`, verbatim from the compliance wiki), `Lint PR commits`
  (`commitlint.yml` + `commitlint.config.cjs`), `Scan for secrets`
  (`gitleaks.yml` + `.gitleaks.toml`, full history, checksum-verified
  binary), `Pre-commit hooks` (`pre-commit.yml`: the husky / lint-staged
  chain — prettier + eslint — over the whole tree) and `Qlty check`. The
  **job names are the contract**: rename one and every merge blocks waiting
  for a check nothing produces. The same ruleset requires one code-owner
  approval, and `CODEOWNERS` names a single owner — who cannot approve their
  own PR.
- **API Monitor** (`.github/workflows/api-monitor.yml` + `.github/scripts/api-monitor.mjs`): Hebdomadaire (lundis 9h UTC). Sonde les fichiers RAML bruts de la doc BoondManager (`resources/{domaine camelCase}/{fichier}.raml` — la page d'index est bloquée par WAF, les fichiers statiques non), hashe leur contenu (SHA-256) et diffe contre `.github/api-snapshot.json`. Domaines = clés de `API_PATHS` (constants.ts) + `EXTRA_DOMAINS` (entités non couvertes). Zéro dépendance npm (fetch natif). PR de mise à jour du snapshot + issue GitHub si changements. Documentation complète: `.github/API_MONITORING.md`.
- **Dependabot**: configured for npm and GitHub Actions.
- **Distribution**: `docs/distribution.md` is the single source of truth for what ships where and the few manual one-time actions still outstanding (GitHub topics, awesome-mcp-servers PR, Glama/PulseMCP/mcp.so submissions).

### Required GitHub secrets

| Secret | Used by | Purpose |
|--------|---------|---------|
| `DOCKERHUB_USERNAME` | `release.yml`, `docker-publish.yml` | Docker Hub user/org that owns the published repo |
| `DOCKERHUB_TOKEN` | `release.yml`, `docker-publish.yml` | Docker Hub access token (Account Settings → Security) |
| `BOOND_SANDBOX_USER_TOKEN` / `BOOND_SANDBOX_CLIENT_TOKEN` / `BOOND_SANDBOX_CLIENT_KEY` | `smoke-live.yml` | Optional. JWT components of a **sandbox** tenant for the read-only live smoke test; absent = job skipped. `BOOND_SANDBOX_BASE_URL` optional too. |

`GITHUB_TOKEN` is auto-provided by GitHub Actions and covers GHCR, GitHub Releases, and CodeQL — no extra setup. The MCP Registry uses GitHub OIDC (no secret).

**npm needs no secret either**: publishing goes through **OIDC trusted
publishing**, configured on npmjs.com (package → Settings → Trusted publishers)
against `silamir` / `boondmanager-mcp-server` / `release.yml`, with
`permissions.id-token: write` in the workflow. `NPM_TOKEN` was removed after a
long-lived automation token expired silently at its 90-day cap and broke the
v2.13.0 release.

Two traps this configuration must keep clear of, both of which produce the
*same* misleading `404 Not Found - PUT` that reads like a bad token:

- **`registry-url` must stay off `actions/setup-node`.** It writes
  `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into `.npmrc`
  unconditionally; with no token that expands to an empty value, npm concludes
  auth is already configured, skips the OIDC exchange, and publishes with empty
  credentials. (`auth-token-line: false` is the explicit fix but does not exist
  at the pinned SHA.)
- **npm must be ≥ 11.5.1** (Node ≥ 22.14.0). Node 22 bundles npm 10.9.x, which
  has no OIDC support at all, so `release.yml` upgrades npm in a dedicated step
  placed *after* the test/build steps — those keep running under the same npm as
  `ci.yml`, so a release can never pass checks in an environment CI never
  exercised.
