---
name: release
description: Cut a new release of boondmanager-mcp-server — CHANGELOG section, every version copy bumped together, release PR through the main rulesets, then tag the squash commit so release.yml publishes.
disable-model-invocation: true
argument-hint: "X.Y.Z"
---

Release version `$ARGUMENTS`. `main` is protected by rulesets: nothing is pushed to
it directly, the release goes through a PR and the tag is placed on the squash commit.

1. Start from an up-to-date, clean `main` (`git switch main && git pull --ff-only`,
   `git status --short` empty). If not, stop and ask.
2. Branch `chore/release-X.Y.Z`. The branch-naming ruleset only accepts
   `^(build|chore|ci|docs|feat|fix|…)/[a-z0-9._-]+$` — `release/X.Y.Z` is refused.
3. `CHANGELOG.md`: turn `[Unreleased]` into `## [X.Y.Z] - YYYY-MM-DD` (French notes,
   English heading). One paragraph per line, on purpose: `release.yml` extracts this
   section verbatim as the GitHub Release body, wrapped lines would show as hard breaks.
4. Bump every version copy together — CI fails on any drift:
   - `package.json`, `manifest.json`, `server.json`, `gemini-extension.json`
   - **both** pins in `server.json.packages[]`: `packages[0].version` (npm) and the
     `vX.Y.Z` inside `packages[1].identifier` (mcpb URL) — `packages[0].version` once
     fossilised at 2.14.0 unnoticed (issue #217)
   - `npm run plugin:manifest` (propagates into `plugins/boondmanager-mcp/…`, including
     the `@X.Y.Z` npm pin), then hand-bump `.claude-plugin/marketplace.json`
   - `package-lock.json`: set `version` and `packages[""].version` with a small node
     script. Do **not** run `npm install --package-lock-only` with the local npm 10:
     it strips the `libc` fields npm 11 wrote and churns ~30 lines.
5. Verify: `npm test && npm run lint && npm run typecheck && npm run build &&
   npm run docs:tools:check && npm run plugin:manifest:check`.
6. Commit by explicit path (never `git add -A`), push, open the PR titled
   `chore(release): X.Y.Z`, then `gh pr checks <n> --watch`.
7. Merge blocked with green checks (`mergeStateStatus: BLOCKED`) means unresolved
   review threads: Qlty's markdownlint opens one per long CHANGELOG line (MD013).
   Resolve them (GraphQL `resolveReviewThread`), do not rewrap the CHANGELOG.
   Then `gh pr merge <n> --squash --delete-branch`.
8. Tag the squash commit, not the branch tip:
   `git switch main && git pull --ff-only && git tag vX.Y.Z <squash-sha> && git push origin vX.Y.Z`.
   One `Release` job publishes npm, GitHub Release (+ `.mcpb`), MCP Registry, GHCR and Docker Hub.
9. Watch the `Release` run, then walk the 7-point checklist in `docs/distribution.md`
   (npm, MCP Registry, Release body, GHCR multi-arch, LobeHub, Smithery, Claude Code
   marketplace). Report each point with the command and its output.

`unpdf` ≥ 2 declares `node >= 24`: an EBADENGINE warning on a Node 22 install is
expected and is not a release failure.
