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

  it("refuses a provider company without its contact, and the reverse (RAML bodyPost.json)", () => {
    const base = { reference: "F-1", resourceId: "9", startDate: "2026-09-01", endDate: "2026-09-30" };
    expect(() => buildProviderInvoiceBody({ ...base, companyId: "1" })).toThrow(/vont ensemble/);
    expect(() => buildProviderInvoiceBody({ ...base, contactId: "2" })).toThrow(/vont ensemble/);
  });
});

describe("boond_provider_invoices_update payments (RAML bodyPut.json)", () => {
  it("maps purchaseId to purchase: { id } and keeps the other payment fields", async () => {
    const { buildProviderInvoiceUpdateBody } = await import("./provider-invoices.js");
    expect(
      buildProviderInvoiceUpdateBody({
        id: "12",
        payments: [
          { purchaseId: "5", state: 1, amountExcludingTax: 100, amountIncludingTax: 120, taxRate: 20 },
          { id: "3", purchaseId: "6", state: 2, amountExcludingTax: 50, amountIncludingTax: 60, taxRate: 20 },
        ],
      })
    ).toEqual({
      data: {
        type: "providerinvoice",
        id: "12",
        attributes: {
          payments: [
            { state: 1, amountExcludingTax: 100, amountIncludingTax: 120, taxRate: 20, purchase: { id: "5" } },
            { id: "3", state: 2, amountExcludingTax: 50, amountIncludingTax: 60, taxRate: 20, purchase: { id: "6" } },
          ],
        },
      },
    });
  });

  it("goes through the handlers: create refuses a lone companyId, update PUTs the mapped payments", async () => {
    const { toolCallback } = await import("./test-helpers.js");
    vi.mocked(apiRequest).mockClear();
    vi.mocked(apiRequest).mockResolvedValue({ data: { id: "12", type: "providerinvoice", attributes: {} } } as never);
    const server = createMockServer();
    registerProviderInvoiceTools(server);
    await expect(
      toolCallback(
        server,
        "boond_provider_invoices_create"
      )({ reference: "F-1", resourceId: "9", startDate: "2026-09-01", endDate: "2026-09-30", companyId: "1" })
    ).rejects.toThrow(/vont ensemble/);
    expect(apiRequest).not.toHaveBeenCalled();
    await toolCallback(
      server,
      "boond_provider_invoices_update"
    )({
      id: "12",
      payments: [{ purchaseId: "5", state: 1, amountExcludingTax: 100, amountIncludingTax: 120, taxRate: 20 }],
    });
    expect(apiRequest).toHaveBeenLastCalledWith("/provider-invoices/12", "PUT", {
      data: {
        type: "providerinvoice",
        id: "12",
        attributes: {
          payments: [
            { state: 1, amountExcludingTax: 100, amountIncludingTax: 120, taxRate: 20, purchase: { id: "5" } },
          ],
        },
      },
    });
  });

  it("requires the documented payment fields and rejects unknown ones", async () => {
    const { ProviderInvoiceUpdateSchema } = await import("../schemas/index.js");
    const ok = { purchaseId: "5", state: 1, amountExcludingTax: 100, amountIncludingTax: 120, taxRate: 20 };
    expect(ProviderInvoiceUpdateSchema.safeParse({ id: "12", payments: [ok] }).success).toBe(true);
    expect(ProviderInvoiceUpdateSchema.safeParse({ id: "12", payments: [{ ...ok, taxRate: undefined }] }).success).toBe(
      false
    );
    expect(ProviderInvoiceUpdateSchema.safeParse({ id: "12", payments: [{ ...ok, deliveryId: "4" }] }).success).toBe(
      false
    );
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

describe("provider invoice search, filters checked read-only on 2026-11-27 (see the schema comment)", () => {
  it("forwards the amount, custom period and multi-id filters of the RAML search.raml", async () => {
    const { apiSearch } = await import("../services/boond-client.js");
    const { toolCallback } = await import("./test-helpers.js");
    vi.mocked(apiSearch).mockResolvedValue({ data: [], meta: { totals: { rows: 0 } } } as never);
    const server = createMockServer();
    registerProviderInvoiceTools(server);
    await toolCallback(
      server,
      "boond_provider_invoices_search"
    )({
      resources: [120, 131],
      companies: [7],
      withoutCompany: false,
      amountType: "between",
      amountColumn: "amountExcludingTax",
      amountMin: 10000,
      amountMax: 13000,
      amountCurrency: 0,
      period: "invoiceDate",
      periodDynamic: "lastCustomPeriod",
      periodDynamicParameters: "3,months",
    });
    expect(vi.mocked(apiSearch).mock.calls.at(-1)?.[1]).toMatchObject({
      resources: [120, 131],
      companies: [7],
      amountType: "between",
      amountColumn: "amountExcludingTax",
      amountMin: 10000,
      amountMax: 13000,
      amountCurrency: 0,
      withoutCompany: "false",
      periodDynamic: "lastCustomPeriod",
      periodDynamicParameters: "3,months",
    });
  });

  it("validates the amount enums and the custom period format", async () => {
    const { ProviderInvoiceSearchSchema } = await import("../schemas/index.js");
    expect(ProviderInvoiceSearchSchema.safeParse({ amountType: "greater" }).success).toBe(false);
    expect(ProviderInvoiceSearchSchema.safeParse({ amountColumn: "amount" }).success).toBe(false);
    expect(ProviderInvoiceSearchSchema.safeParse({ periodDynamicParameters: "3 months" }).success).toBe(false);
    expect(ProviderInvoiceSearchSchema.safeParse({ periodDynamicParameters: "101,days" }).success).toBe(false);
    expect(ProviderInvoiceSearchSchema.safeParse({ periodDynamicParameters: "12,weeks" }).success).toBe(true);
  });
});

describe("provider invoice shared write relationships (RAML bodyPost / bodyPut)", () => {
  it("sends mainManager, agency, pole and billingDetail on create, and stateReason / payments as attributes", () => {
    expect(
      buildProviderInvoiceBody({
        reference: "F-1",
        resourceId: "9",
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        mainManagerId: "1",
        agencyId: "2",
        poleId: "3",
        billingDetailId: "4",
        stateReason: { typeOf: 1, detail: "x" },
        payments: [{ deliveryId: "8", state: 1, amountExcludingTax: 10 }],
      })
    ).toEqual({
      data: {
        type: "providerinvoice",
        attributes: {
          reference: "F-1",
          startDate: "2026-09-01",
          endDate: "2026-09-30",
          stateReason: { typeOf: 1, detail: "x" },
          payments: [{ deliveryId: "8", state: 1, amountExcludingTax: 10 }],
        },
        relationships: {
          resource: { data: { id: "9", type: "resource" } },
          mainManager: { data: { id: "1", type: "resource" } },
          agency: { data: { id: "2", type: "agency" } },
          pole: { data: { id: "3", type: "pole" } },
          billingDetail: { data: { id: "4", type: "billingdetail" } },
        },
      },
    });
  });

  it("clears pole and billingDetail with null on update and PUTs through the handler", async () => {
    const { toolCallback } = await import("./test-helpers.js");
    vi.mocked(apiRequest).mockClear();
    vi.mocked(apiRequest).mockResolvedValue({ data: { id: "12", type: "providerinvoice", attributes: {} } } as never);
    const server = createMockServer();
    registerProviderInvoiceTools(server);
    await toolCallback(
      server,
      "boond_provider_invoices_update"
    )({ id: "12", mainManagerId: "1", poleId: null, billingDetailId: null, currency: 0 });
    expect(apiRequest).toHaveBeenLastCalledWith("/provider-invoices/12", "PUT", {
      data: {
        type: "providerinvoice",
        id: "12",
        attributes: { currency: 0 },
        relationships: {
          mainManager: { data: { id: "1", type: "resource" } },
          pole: { data: null },
          billingDetail: { data: null },
        },
      },
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

describe("boond_provider_invoices_update provider relationships (RAML providerInvoices/bodyPut.json)", () => {
  it("sends providerCompany and providerContact together", async () => {
    const { buildProviderInvoiceUpdateBody } = await import("./provider-invoices.js");
    expect(buildProviderInvoiceUpdateBody({ id: "12", provider: { companyId: "7", contactId: "8" } })).toEqual({
      data: {
        type: "providerinvoice",
        id: "12",
        attributes: {},
        relationships: {
          providerCompany: { data: { id: "7", type: "company" } },
          providerContact: { data: { id: "8", type: "contact" } },
        },
      },
    });
  });

  it("clears both with provider: null", async () => {
    const { buildProviderInvoiceUpdateBody } = await import("./provider-invoices.js");
    expect(buildProviderInvoiceUpdateBody({ id: "12", provider: null })).toEqual({
      data: {
        type: "providerinvoice",
        id: "12",
        attributes: {},
        relationships: { providerCompany: { data: null }, providerContact: { data: null } },
      },
    });
  });

  it("sends no relationships block without provider", async () => {
    const { buildProviderInvoiceUpdateBody } = await import("./provider-invoices.js");
    expect(buildProviderInvoiceUpdateBody({ id: "12", reference: "F-1" })).toEqual({
      data: { type: "providerinvoice", id: "12", attributes: { reference: "F-1" } },
    });
  });

  it("rejects a company without its contact, and accepts a numeric resourceId", async () => {
    const { ProviderInvoiceUpdateSchema } = await import("../schemas/index.js");
    expect(ProviderInvoiceUpdateSchema.safeParse({ id: "12", provider: { companyId: "7" } }).success).toBe(false);
    expect(ProviderInvoiceUpdateSchema.safeParse({ id: "12", resourceId: "9" }).success).toBe(true);
    expect(ProviderInvoiceUpdateSchema.safeParse({ id: "12", resourceId: "9/x" }).success).toBe(false);
    expect(ProviderInvoiceUpdateSchema.safeParse({ id: "12", provider: null }).success).toBe(true);
  });

  it("sends resourceId as the `resource` relationship, alone or with the provider", async () => {
    const { buildProviderInvoiceUpdateBody } = await import("./provider-invoices.js");
    expect(buildProviderInvoiceUpdateBody({ id: "12", resourceId: "42" })).toEqual({
      data: {
        type: "providerinvoice",
        id: "12",
        attributes: {},
        relationships: { resource: { data: { id: "42", type: "resource" } } },
      },
    });
    expect(
      buildProviderInvoiceUpdateBody({ id: "12", resourceId: "42", provider: { companyId: "7", contactId: "8" } })
    ).toEqual({
      data: {
        type: "providerinvoice",
        id: "12",
        attributes: {},
        relationships: {
          resource: { data: { id: "42", type: "resource" } },
          providerCompany: { data: { id: "7", type: "company" } },
          providerContact: { data: { id: "8", type: "contact" } },
        },
      },
    });
  });
});

describe("boond_provider_invoices_update handler with provider", () => {
  it("PUTs attributes and both provider relationships, or clears them", async () => {
    const { toolCallback } = await import("./test-helpers.js");
    vi.mocked(apiRequest).mockClear();
    vi.mocked(apiRequest).mockResolvedValue({ data: { id: "12", type: "providerinvoice", attributes: {} } } as never);
    const server = createMockServer();
    registerProviderInvoiceTools(server);
    const update = toolCallback(server, "boond_provider_invoices_update");
    await update({ id: "12", paidDate: "2026-11-30", provider: { companyId: "7", contactId: "8" } });
    expect(apiRequest).toHaveBeenLastCalledWith("/provider-invoices/12", "PUT", {
      data: {
        type: "providerinvoice",
        id: "12",
        attributes: { paidDate: "2026-11-30" },
        relationships: {
          providerCompany: { data: { id: "7", type: "company" } },
          providerContact: { data: { id: "8", type: "contact" } },
        },
      },
    });
    await update({ id: "12", resourceId: "42" });
    expect(apiRequest).toHaveBeenLastCalledWith("/provider-invoices/12", "PUT", {
      data: {
        type: "providerinvoice",
        id: "12",
        attributes: {},
        relationships: { resource: { data: { id: "42", type: "resource" } } },
      },
    });
    await update({ id: "12", provider: null });
    expect(apiRequest).toHaveBeenLastCalledWith("/provider-invoices/12", "PUT", {
      data: {
        type: "providerinvoice",
        id: "12",
        attributes: {},
        relationships: { providerCompany: { data: null }, providerContact: { data: null } },
      },
    });
  });
});

describe("providerInvoiceSummary VAT number", () => {
  it("shows the supplier's VAT number carried by list rows", async () => {
    const { providerInvoiceSummary } = await import("./provider-invoices.js");
    expect(
      providerInvoiceSummary({
        id: "145",
        type: "providerinvoice",
        attributes: { reference: "F-9", source: 1, vatNumber: "FR00123456789" },
        relationships: { agency: { data: { id: "1", type: "agency" } } },
      } as never)
    ).toBe("[providerinvoice #145] | Réf: F-9 | Source: électronique | TVA: FR00123456789 | Sans ressource");
  });
});

describe("provider invoice handlers, remaining documented fields", () => {
  it("sends stateReason and creationDate through boond_provider_invoices_update", async () => {
    const { toolCallback } = await import("./test-helpers.js");
    vi.mocked(apiRequest).mockClear();
    vi.mocked(apiRequest).mockResolvedValue({ data: { id: "12", type: "providerinvoice", attributes: {} } } as never);
    const server = createMockServer();
    registerProviderInvoiceTools(server);
    await toolCallback(
      server,
      "boond_provider_invoices_update"
    )({ id: "12", stateReason: { typeOf: 2, detail: "montant" }, creationDate: "2026-11-26T12:04:16+0100" });
    expect(apiRequest).toHaveBeenLastCalledWith("/provider-invoices/12", "PUT", {
      data: {
        type: "providerinvoice",
        id: "12",
        attributes: { stateReason: { typeOf: 2, detail: "montant" }, creationDate: "2026-11-26T12:04:16+0100" },
      },
    });
  });

  it("POSTs payments by delivery and stateReason through boond_provider_invoices_create", async () => {
    const { toolCallback } = await import("./test-helpers.js");
    vi.mocked(apiRequest).mockClear();
    vi.mocked(apiRequest).mockResolvedValue({ data: { id: "13", type: "providerinvoice", attributes: {} } } as never);
    const server = createMockServer();
    registerProviderInvoiceTools(server);
    await toolCallback(
      server,
      "boond_provider_invoices_create"
    )({
      reference: "F-2",
      resourceId: "9",
      startDate: "2026-11-01",
      endDate: "2026-11-30",
      state: 0,
      stateReason: { typeOf: 1 },
      payments: [{ deliveryId: "8", state: 1, amountExcludingTax: 100 }],
    });
    expect(apiRequest).toHaveBeenLastCalledWith("/provider-invoices", "POST", {
      data: {
        type: "providerinvoice",
        attributes: {
          reference: "F-2",
          startDate: "2026-11-01",
          endDate: "2026-11-30",
          state: 0,
          stateReason: { typeOf: 1 },
          payments: [{ deliveryId: "8", state: 1, amountExcludingTax: 100 }],
        },
        relationships: { resource: { data: { id: "9", type: "resource" } } },
      },
    });
  });

  it("tells the model that the amount filter needs amountCurrency", async () => {
    const { ProviderInvoiceSearchSchema } = await import("../schemas/index.js");
    expect(ProviderInvoiceSearchSchema.shape.amountCurrency.description).toMatch(/Obligatoire avec `amountType`/);
  });
});
