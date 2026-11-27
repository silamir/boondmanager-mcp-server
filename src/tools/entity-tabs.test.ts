import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENTITY_TABS } from "../constants.js";
import { apiRequest } from "../services/boond-client.js";
import { registerCandidateTools } from "./candidates.js";
import { registerResourceTools } from "./resources.js";
import { registerContactTools } from "./contacts.js";
import { registerCompanyTools } from "./companies.js";
import { registerOpportunityTools } from "./opportunities.js";
import { registerProjectTools } from "./projects.js";
import { registerInvoiceTools } from "./invoices.js";
import { registerOrderTools } from "./orders.js";
import { registerPurchaseTools } from "./purchases.js";

vi.mock("../services/boond-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/boond-client.js")>();
  return { ...actual, apiRequest: vi.fn() };
});

/**
 * Every tab tool reads a segment listed in `ENTITY_TABS` for its entity.
 * `boond_companies_provider_invoices` shipped with `provider_invoices` while
 * `ENTITY_TABS.companies` already had the right `provider-invoices`: nothing
 * compared the two, and the tool answered 404 on every call.
 */
describe("tab tools and ENTITY_TABS", () => {
  it("every tab tool calls a segment listed in ENTITY_TABS for its entity", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ data: [] } as never);
    const server = { registerTool: vi.fn() } as unknown as McpServer;
    for (const register of [
      registerCandidateTools,
      registerResourceTools,
      registerContactTools,
      registerCompanyTools,
      registerOpportunityTools,
      registerProjectTools,
      registerInvoiceTools,
      registerOrderTools,
      registerPurchaseTools,
    ]) {
      register(server);
    }
    const tabs = ENTITY_TABS as Readonly<Record<string, readonly string[]>>;
    const misses: string[] = [];
    let checked = 0;
    for (const [name, , handler] of vi.mocked(server.registerTool).mock.calls) {
      vi.mocked(apiRequest).mockClear();
      await (handler as (p: unknown) => Promise<unknown>)({ id: "1" }).catch(() => undefined);
      for (const [path, method] of vi.mocked(apiRequest).mock.calls) {
        const match = /^\/([a-z-]+)\/1\/([^/?]+)$/.exec(String(path));
        if (!match || (method !== undefined && method !== "GET")) continue;
        const [, entity = "", segment = ""] = match;
        if (!(entity in tabs)) continue;
        checked += 1;
        if (!(tabs[entity] ?? []).includes(segment)) misses.push(`${String(name)} → ${String(path)}`);
      }
    }
    expect(checked).toBeGreaterThan(40);
    expect(misses).toEqual([]);
  });
});
