import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ProviderInvoiceCreateSchema,
  ProviderInvoiceSearchSchema,
  ProviderInvoiceUpdateSchema,
} from "../schemas/index.js";
import {
  buildJsonApiBody,
  registerCreateTool,
  registerDeleteTool,
  registerGetTool,
  registerSearchTool,
  registerUpdateTool,
} from "./crud-factory.js";
import { composeDescription } from "./description-builders.js";
import type { JsonApiResource } from "../types.js";

const OPTS = {
  entityName: "facture fournisseur",
  entityNamePlural: "factures fournisseur",
  apiPath: "/provider-invoices",
  prefix: "boond_provider_invoices",
};

/** `/provider-invoices` payload: `resource` is mandatory, `providerCompany` / `providerContact` optional. */
export function buildProviderInvoiceBody(params: Record<string, unknown>): unknown {
  const { companyId, contactId, resourceId, ...attrs } = params;
  return buildJsonApiBody("providerinvoice", attrs, undefined, {
    resource: { id: String(resourceId), type: "resource" },
    providerCompany: companyId ? { id: String(companyId), type: "company" } : undefined,
    providerContact: contactId ? { id: String(contactId), type: "contact" } : undefined,
  });
}

/**
 * `PUT /provider-invoices/{id}` payload. `provider` sets `providerCompany` and
 * `providerContact` together (the RAML requires both once one is set) or, as
 * `null`, clears both. `resourceId` sets `resource`: absent from the RAML
 * `bodyPut.json`, but applied by the API (changed and restored live, 2026-11-26).
 */
export function buildProviderInvoiceUpdateBody(params: Record<string, unknown>): unknown {
  const { id, provider, resourceId, ...attrs } = params;
  const p = provider as { companyId: string; contactId: string } | null | undefined;
  const relationships = {
    ...(resourceId ? { resource: { id: String(resourceId), type: "resource" } } : {}),
    ...(p === undefined
      ? {}
      : {
          providerCompany: p === null ? null : { id: String(p.companyId), type: "company" },
          providerContact: p === null ? null : { id: String(p.contactId), type: "contact" },
        }),
  };
  return buildJsonApiBody(
    "providerinvoice",
    attrs,
    String(id),
    Object.keys(relationships).length > 0 ? relationships : undefined
  );
}

const SOURCE_LABELS: Readonly<Record<number, string>> = { 0: "manuelle", 1: "électronique" };

/**
 * One line per provider invoice: what a human needs to recognise it and to
 * spot the ones still to process (an e-invoice that arrived without a
 * resource). The default summary only showed the state id and the reference.
 */
export function providerInvoiceSummary(item: JsonApiResource): string {
  const a = item.attributes ?? {};
  const rel = item.relationships as Record<string, { data?: { id?: string } | null } | undefined> | undefined;
  // In list rows (verified live) an invoice without resource has no `resource`
  // key at all, while one with a resource carries it; `data: null` is the
  // detail form. Without any relationships block we cannot tell, so say nothing.
  const resourceId = rel?.["resource"]?.data?.id;
  const resourceLabel = resourceId ? `Ressource: #${resourceId}` : rel ? "Sans ressource" : undefined;
  const source = typeof a["source"] === "number" ? (SOURCE_LABELS[a["source"]] ?? `source ${a["source"]}`) : undefined;
  const ht = a["amountExcludingTax"] ?? undefined;
  const ttc = a["amountIncludingTax"] ?? undefined;
  const amounts =
    ht !== undefined || ttc !== undefined ? `${String(ht ?? "?")} HT / ${String(ttc ?? "?")} TTC` : undefined;
  const parts = [
    `[providerinvoice #${item.id}]`,
    a["reference"] !== undefined && a["reference"] !== null ? `Réf: ${String(a["reference"])}` : undefined,
    a["invoiceDate"] ? `Date: ${String(a["invoiceDate"])}` : undefined,
    amounts,
    a["state"] !== undefined && a["state"] !== null ? `Statut: ${String(a["state"])}` : undefined,
    source ? `Source: ${source}` : undefined,
    a["vatNumber"] ? `TVA: ${String(a["vatNumber"])}` : undefined,
    resourceLabel,
  ];
  return parts.filter((p): p is string => p !== undefined).join(" | ");
}

export function registerProviderInvoiceTools(server: McpServer): void {
  registerCreateTool(server, OPTS, ProviderInvoiceCreateSchema, buildProviderInvoiceBody, {
    title: "Créer une facture fournisseur",
    description: composeDescription({
      purpose: "Crée une facture fournisseur (facture reçue d'un prestataire).",
      when: "pour enregistrer la facture émise par un sous-traitant.",
      instead:
        "`boond_invoices_create` pour une facture de vente adressée à un client — les deux sens ne partagent pas d'endpoint.",
      behaviour: [
        "`resource`, `providerCompany` et `providerContact` sont attendus sous forme d'ID numériques.",
        "Écriture non idempotente.",
      ],
      returns: "confirmation et fiche de la facture fournisseur créée, avec son ID dans `structuredContent.id`.",
    }),
  });

  registerSearchTool(server, OPTS, {
    schema: ProviderInvoiceSearchSchema,
    summaryFn: providerInvoiceSummary,
    description: composeDescription({
      purpose: "Liste et recherche les factures fournisseur (factures reçues des prestataires).",
      when: "pour suivre les factures d'achat, par fournisseur, état, origine (saisie manuelle / facture électronique reçue) ou période ; `withoutResource: true` + `sources: [1]` = factures électroniques arrivées sans ressource, à rattacher avec `boond_provider_invoices_update` (`resourceId`).",
      instead:
        "`boond_invoices_search` pour les factures de vente adressées aux clients — sens opposé, endpoint distinct.",
      returns:
        "page de résumés de factures fournisseur (référence, date, montants, état, origine, n° de TVA du fournisseur, ressource ou « Sans ressource »). Lecture seule.",
    }),
  });

  registerGetTool(server, OPTS, { withTab: false, title: "Détails d'une facture fournisseur" });

  // Issue #252: mark a provider invoice paid (paidDate / state), fix a period or an amount.
  registerUpdateTool(server, OPTS, ProviderInvoiceUpdateSchema, buildProviderInvoiceUpdateBody, {
    method: "PUT",
    title: "Modifier une facture fournisseur",
    description: composeDescription({
      purpose:
        "Modifie une facture fournisseur : dates, montants, état, ressource (`resourceId`), ou la société et le contact fournisseur (`provider`).",
      when: "pour marquer une facture payée (`paidDate`, `state`), corriger une période ou un montant, rattacher une facture électronique reçue sans ressource (`resourceId`), ou rattacher / détacher le fournisseur.",
      instead: "`boond_provider_invoices_create` pour enregistrer une nouvelle facture.",
      behaviour: [
        "`PUT /provider-invoices/{id}` vérifié sur une instance réelle avec `resourceId` (ressource changée puis remise, autres champs intacts) ; `provider` non vérifié.",
        "`provider` envoie `providerCompany` et `providerContact` ensemble (la doc de l'API les exige ensemble) ; `provider: null` retire les deux.",
      ],
      returns: "confirmation et fiche de la facture fournisseur modifiée.",
    }),
  });
  registerDeleteTool(server, OPTS, { title: "Supprimer une facture fournisseur" });
}
