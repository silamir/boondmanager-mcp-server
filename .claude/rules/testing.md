---
paths:
  - "**/*.test.ts"
  - "src/tools/test-helpers.ts"
  - "vitest.config.ts"
---

# Testing conventions

<!-- Moved verbatim from CLAUDE.md; loaded only when Claude works on the files above. -->

## Testing

- **Framework**: Vitest 5 (with `globals: true`)
- **Pattern**: Each module file has a corresponding `.test.ts` file
- **Approach**: Mock `McpServer` with `{ registerTool: vi.fn() }`,
  `registerPrompt`, `registerResource` as needed, then verify:
  1. Correct number of `registerTool`/`registerPrompt`/`registerResource` calls
  2. Correct names / URIs
  3. Correct MCP annotations (readOnlyHint, destructiveHint, idempotentHint)
  4. For prompts: callback returns a non-empty user message that references
     the right tool names and filter shortcuts
  5. For resources: read callback hits the expected API path
- **Coverage**: V8 provider, excludes test files and index.ts. The thresholds
  in `vitest.config.ts` are **per folder and per file**, not only global
  (issue #245): a 92 % global figure used to hide `tab-tools.ts` at 50 % and
  `projects.ts` at 55 %, because those suites asserted the registration and
  never ran a handler. `src/tools/**`, `src/services/**` and
  `src/transports/**` each have their own floor, and `perFile` (80 % lines,
  65 % functions, 55 % branches) is what names the untested domain when a
  new one lands with a registration-only suite. A handler test — invoke the
  registered callback with a mocked `apiRequest` / `apiSearch` and assert the
  path, method and body (`tab-tools.test.ts`, `projects.test.ts`,
  `absences.test.ts`) — is what a domain needs to clear it; a `build*Body`
  with optional relationships also needs its "absent" branch exercised.
- **No test count is quoted here** (issue #264): it rotted on every PR and
  nothing checked it. The catalogue figures in *Project Overview* and in
  `README.md` **are** checked — `src/catalogue-counts.test.ts` parses both
  sentences and compares them to a real client's `tools/list`,
  `prompts/list`, `resources/list` and `resources/templates/list`, so adding a
  tool means editing those two sentences (and `TOOLS.md`, which CI regenerates).

### Test file template (for read-only search+get domains)

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerXxxTools } from "./xxx.js";

function createMockServer() {
  return { registerTool: vi.fn() } as unknown as McpServer;
}

describe("registerXxxTools", () => {
  let server: McpServer;
  beforeEach(() => { server = createMockServer(); });

  it("should register N tools", () => {
    registerXxxTools(server);
    expect(server.registerTool).toHaveBeenCalledTimes(N);
  });

  it("should register all expected tool names", () => {
    registerXxxTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_xxx_search");
    expect(names).toContain("boond_xxx_get");
  });

  it("should register all tools as readOnly", () => {
    registerXxxTools(server);
    for (const call of vi.mocked(server.registerTool).mock.calls) {
      expect(call[1].annotations?.readOnlyHint).toBe(true);
    }
  });
});
```
