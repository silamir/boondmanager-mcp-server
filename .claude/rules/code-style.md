---
paths:
  - "src/**/*.ts"
  - "eslint.config.*"
  - "tsconfig.json"
---

# Code style: lint and tsconfig strictness

<!-- Moved verbatim from CLAUDE.md; loaded only when Claude works on the files above. -->

## Code Style

- ESLint 10 + typescript-eslint **`recommendedTypeChecked`** (issue #245) —
  `parserOptions.project` was declared for years while only the untyped set
  ran. What is on top: `no-floating-promises`, `switch-exhaustiveness-check`;
  what is deliberately off, project-wide: `no-base-to-string` and
  `restrict-template-expressions` (rendering `Record<string, unknown>`
  attribute bags is the formatters' whole job; objects already go through
  `renderAttributeValue()`); `prefer-promise-reject-errors` allows `any` /
  `unknown` (`AbortSignal.reason`). `**/*.test.ts` and `test-helpers.ts` relax
  the `no-unsafe-*`, `unbound-method`, `require-await` and
  `no-unnecessary-type-assertion` rules — mocks at the module boundary trip
  ~700 of them for no defect. Don't add a rule to that override to silence a
  finding in `src/`; fix the site.
- `tsconfig.json` carries `noImplicitOverride`, `noImplicitReturns`,
  `noFallthroughCasesInSwitch`, `verbatimModuleSyntax` (zero cost when
  enabled, #245) and, since issue #289, `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. Conventions they impose: an indexed access
  (`arr[i]`, `record[key]`, a regex capture group) is narrowed with a guard or
  a `?? default`, never a `!`; an optional property is *omitted* rather than
  set to `undefined` (`...(x !== undefined ? { x } : {})`, or
  `optional(key, value)` in `transports/http.ts`); the Zod-inferred search
  params carry `| undefined` on every optional key, so `SearchParams` declares
  it too. The `asTransport()` cast in `transports/http.ts` is gone since SDK
  1.32.2, which declares `Transport`'s optional members with `| undefined`.
- `@typescript-eslint/no-unused-vars` with `argsIgnorePattern: "^_"`
- `@typescript-eslint/no-explicit-any` as warning
- No semicolons preference not enforced (current code uses semicolons)
- French descriptions in tool / prompt / resource metadata (titles, descriptions)
- English for code, comments, commit messages, and `CHANGELOG.md` headings
- License: Apache-2.0 (every PR inherits the project license; no per-file headers)
