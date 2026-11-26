import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildProviderInvoiceBody, registerProviderInvoiceTools } from "./provider-invoices.js";
import { apiRequest } from "../services/boond-client.js";

vi.mock("../services/boond-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/boond-client.js")>();
  return { ...actual, apiRequest: vi.fn(), apiSearch: vi.fn() };
});

function createMockServer() {
  return {
    registerTool: vi.fn(),
  } as unknown as McpServer;
}

describe("registerProviderInvoiceTools", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMockServer();
    vi.mocked(apiRequest).mockClear();
    vi.mocked(apiRequest).mockResolvedValue({ data: { id: "11", type: "providerinvoice", attributes: {} } } as never);
  });

  it("should register 3 provider invoice tools", () => {
    registerProviderInvoiceTools(server);
    expect(server.registerTool).toHaveBeenCalledTimes(5);
  });

  it("should register all expected tool names", () => {
    registerProviderInvoiceTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_provider_invoices_create");
    expect(names).toContain("boond_provider_invoices_search");
    expect(names).toContain("boond_provider_invoices_get");
  });

  it("should register search/get as readOnly and create as write", () => {
    registerProviderInvoiceTools(server);
    const calls = vi.mocked(server.registerTool).mock.calls;
    expect(calls.find((c) => c[0] === "boond_provider_invoices_create")?.[1].annotations?.readOnlyHint).toBe(false);
    expect(calls.find((c) => c[0] === "boond_provider_invoices_search")?.[1].annotations?.readOnlyHint).toBe(true);
    expect(calls.find((c) => c[0] === "boond_provider_invoices_get")?.[1].annotations?.readOnlyHint).toBe(true);
  });

  it("rejects provider invoice fields that are not mapped", () => {
    registerProviderInvoiceTools(server);
    const call = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === "boond_provider_invoices_create");
    const schema = call?.[1].inputSchema as { safeParse: (input: unknown) => { success: boolean } };

    expect(
      schema.safeParse({
        reference: "FF-1",
        resourceId: "4",
        startDate: "2026-08-01",
        endDate: "2026-08-31",
        dueDate: "2026-09-30",
      }).success
    ).toBe(false);
  });

  it("maps create input to providerCompany/providerContact/resource relationships", async () => {
    registerProviderInvoiceTools(server);
    const call = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === "boond_provider_invoices_create");
    const handler = call?.[2] as (params: unknown) => Promise<unknown>;

    await handler({
      reference: "FF-1",
      resourceId: "4",
      companyId: "1",
      contactId: "2",
      invoiceDate: "2026-08-18",
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      amountExcludingTax: 4700,
    });

    expect(apiRequest).toHaveBeenCalledWith("/provider-invoices", "POST", {
      data: {
        type: "providerinvoice",
        attributes: {
          reference: "FF-1",
          invoiceDate: "2026-08-18",
          startDate: "2026-08-01",
          endDate: "2026-08-31",
          amountExcludingTax: 4700,
        },
        relationships: {
          resource: { data: { id: "4", type: "resource" } },
          providerCompany: { data: { id: "1", type: "company" } },
          providerContact: { data: { id: "2", type: "contact" } },
        },
      },
    });
  });
});

describe("buildProviderInvoiceBody (#245)", () => {
  it("keeps only the resource relationship when no provider company / contact is given", () => {
    expect(
      buildProviderInvoiceBody({ reference: "F-1", resourceId: "9", startDate: "2026-09-01", endDate: "2026-09-30" })
    ).toEqual({
      data: {
        type: "providerinvoice",
        attributes: { reference: "F-1", startDate: "2026-09-01", endDate: "2026-09-30" },
        relationships: { resource: { data: { id: "9", type: "resource" } } },
      },
    });
  });
});

describe("boond_provider_invoices_update / _delete (issue #252)", () => {
  it("PUTs the attributes on /provider-invoices/{id}", async () => {
    const server = createMockServer();
    vi.mocked(apiRequest).mockClear();
    registerProviderInvoiceTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toEqual(expect.arrayContaining(["boond_provider_invoices_update", "boond_provider_invoices_delete"]));
    const handler = vi
      .mocked(server.registerTool)
      .mock.calls.find((c) => c[0] === "boond_provider_invoices_update")![2] as (p: unknown) => Promise<unknown>;
    await handler({ id: "11", paidDate: "2026-09-26", state: 3 });
    expect(apiRequest).toHaveBeenCalledWith("/provider-invoices/11", "PUT", {
      data: { type: "providerinvoice", id: "11", attributes: { paidDate: "2026-09-26", state: 3 } },
    });
  });
});

describe("provider invoice search (filters verified live 2026-11-26)", () => {
  it("forwards providerInvoiceStates, sources, withoutResource and the period filters verbatim", async () => {
    const { apiSearch } = await import("../services/boond-client.js");
    const { toolCallback } = await import("./test-helpers.js");
    vi.mocked(apiSearch).mockResolvedValue({ data: [], meta: { totals: { rows: 0 } } } as never);
    const server = createMockServer();
    registerProviderInvoiceTools(server);
    await toolCallback(
      server,
      "boond_provider_invoices_search"
    )({
      providerInvoiceStates: [1],
      sources: [1],
      withoutResource: true,
      period: "invoiceDate",
      startDate: "2026-11-01",
      endDate: "2026-11-30",
    });
    const query = vi.mocked(apiSearch).mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(vi.mocked(apiSearch).mock.calls.at(-1)?.[0]).toBe("/provider-invoices");
    expect(query).toMatchObject({
      providerInvoiceStates: [1],
      sources: [1],
      withoutResource: "true",
      period: "invoiceDate",
      startDate: "2026-11-01",
      endDate: "2026-11-30",
    });
  });
});

describe("providerInvoiceSummary", () => {
  it("shows reference, date, amounts, state, source and resource", async () => {
    const { providerInvoiceSummary } = await import("./provider-invoices.js");
    expect(
      providerInvoiceSummary({
        id: "143",
        type: "providerinvoice",
        attributes: {
          reference: "F-2026-11-011",
          invoiceDate: "2026-11-24",
          amountExcludingTax: 15725,
          amountIncludingTax: 18870,
          state: 1,
          source: 1,
        },
        relationships: { resource: { data: null } },
      } as never)
    ).toBe(
      "[providerinvoice #143] | Réf: F-2026-11-011 | Date: 2026-11-24 | 15725 HT / 18870 TTC | Statut: 1 | Source: électronique | Sans ressource"
    );
    expect(
      providerInvoiceSummary({
        id: "130",
        type: "providerinvoice",
        attributes: { reference: "F-2026-11-010", source: 0 },
        relationships: { resource: { data: { id: "140", type: "resource" } } },
      } as never)
    ).toBe("[providerinvoice #130] | Réf: F-2026-11-010 | Source: manuelle | Ressource: #140");
  });
});

describe("providerInvoiceSummary resource label", () => {
  it("says 'Sans ressource' when the row has relationships but no resource key (list form)", async () => {
    const { providerInvoiceSummary } = await import("./provider-invoices.js");
    expect(
      providerInvoiceSummary({
        id: "144",
        type: "providerinvoice",
        attributes: { reference: "F-2026-110" },
        relationships: { agency: { data: { id: "1", type: "agency" } } },
      } as never)
    ).toBe("[providerinvoice #144] | Réf: F-2026-110 | Sans ressource");
  });

  it("says nothing about the resource when the row has no relationships block", async () => {
    const { providerInvoiceSummary } = await import("./provider-invoices.js");
    expect(providerInvoiceSummary({ id: "1", type: "providerinvoice", attributes: { reference: "X" } } as never)).toBe(
      "[providerinvoice #1] | Réf: X"
    );
  });

  it("never prints 'null' for a null amount", async () => {
    const { providerInvoiceSummary } = await import("./provider-invoices.js");
    expect(
      providerInvoiceSummary({
        id: "2",
        type: "providerinvoice",
        attributes: { amountExcludingTax: null, amountIncludingTax: 120 },
      } as never)
    ).toBe("[providerinvoice #2] | ? HT / 120 TTC");
  });
});
