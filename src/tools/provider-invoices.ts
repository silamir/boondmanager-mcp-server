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

type RelationshipRef = { id: string; type: string } | null;

/**
 * Relationships shared by the create and update bodies (RAML bodyPost.json /
 * bodyPut.json): `mainManager`, `agency`, and the nullable `pole` /
 * `billingDetail` (`null` clears the link). Absent ids are not sent.
 */
function sharedRelationships(params: Record<string, unknown>): Record<string, RelationshipRef> {
  const rels: Record<string, RelationshipRef> = {};
  const set = (key: string, name: string, type: string): void => {
    const value = params[key];
    if (value === null) rels[name] = null;
    else if (value !== undefined) rels[name] = { id: String(value), type };
  };
  set("mainManagerId", "mainManager", "resource");
  set("agencyId", "agency", "agency");
  set("poleId", "pole", "pole");
  set("billingDetailId", "billingDetail", "billingdetail");
  return rels;
}

/**
 * `/provider-invoices` payload: `resource` is mandatory, `providerCompany` /
 * `providerContact` optional but, per the RAML bodyPost.json, set together.
 */
export function buildProviderInvoiceBody(params: Record<string, unknown>): unknown {
  const { companyId, contactId, resourceId, mainManagerId, agencyId, poleId, billingDetailId, ...attrs } = params;
  if (Boolean(companyId) !== Boolean(contactId)) {
    throw new Error(
      "`companyId` et `contactId` vont ensemble : l'API exige le contact fournisseur dès que la société est renseignée, et inversement."
    );
  }
  return buildJsonApiBody("providerinvoice", attrs, undefined, {
    resource: { id: String(resourceId), type: "resource" },
    providerCompany: companyId ? { id: String(companyId), type: "company" } : undefined,
    providerContact: contactId ? { id: String(contactId), type: "contact" } : undefined,
    ...sharedRelationships({ mainManagerId, agencyId, poleId, billingDetailId }),
  });
}

/**
 * `PUT /provider-invoices/{id}` payload. `provider` sets `providerCompany` and
 * `providerContact` together (the RAML requires both once one is set) or, as
 * `null`, clears both. `resourceId` sets `resource`: absent from the RAML
 * `bodyPut.json`, but applied by the API (changed and restored live, 2026-11-26).
 */
export function buildProviderInvoiceUpdateBody(params: Record<string, unknown>): unknown {
  const { id, provider, resourceId, payments, mainManagerId, agencyId, poleId, billingDetailId, ...attrs } = params;
  const p = provider as { companyId: string; contactId: string } | null | undefined;
  if (Array.isArray(payments)) {
    // RAML bodyPut.json: `purchase: { id }`, not a flat purchaseId.
    attrs["payments"] = (payments as Array<Record<string, unknown>>).map(({ purchaseId, ...rest }) => ({
      ...rest,
      purchase: { id: String(purchaseId) },
    }));
  }
  const relationships = {
    ...(resourceId ? { resource: { id: String(resourceId), type: "resource" } } : {}),
    ...sharedRelationships({ mainManagerId, agencyId, poleId, billingDetailId }),
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
        "`resource`, `providerCompany` et `providerContact` sont attendus sous forme d'ID numériques ; `companyId` et `contactId` vont ensemble (exigé par l'API).",
        "`mainManagerId`, `agencyId`, `poleId`, `billingDetailId`, `stateReason` et `payments` (par prestation) suivent la doc de l'API, non vérifiés.",
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
      when: "pour suivre les factures d'achat, par fournisseur, ressource, état, origine (saisie manuelle / facture électronique reçue), période ou montant (`amountType` + `amount` ou `amountMin` / `amountMax`, non vérifié) ; `withoutResource: true` + `sources: [1]` = factures électroniques arrivées sans ressource, à rattacher avec `boond_provider_invoices_update` (`resourceId`).",
      instead:
        "`boond_invoices_search` pour les factures de vente adressées aux clients — sens opposé, endpoint distinct.",
      returns:
        "page de résumés de factures fournisseur (référence, date, montants, état, origine, n° de TVA du fournisseur, ressource ou « Sans ressource »). Lecture seule.",
    }),
  });

  registerGetTool(server, OPTS, { withTab: false, title: "Détails d'une facture fournisseur" });

  // Issue #252: change the state, fix a period or an amount. paidDate / dueDate are not in
  // the RAML bodyPut.json; payments are the documented way to record a settlement.
  registerUpdateTool(server, OPTS, ProviderInvoiceUpdateSchema, buildProviderInvoiceUpdateBody, {
    method: "PUT",
    title: "Modifier une facture fournisseur",
    description: composeDescription({
      purpose:
        "Modifie une facture fournisseur : dates, montants, état, ressource (`resourceId`), ou la société et le contact fournisseur (`provider`).",
      when: "pour changer l'état, corriger une période ou un montant, rattacher une facture électronique reçue sans ressource (`resourceId`), rattacher / détacher le fournisseur, ou lier la facture à ses achats (`payments`).",
      instead: "`boond_provider_invoices_create` pour enregistrer une nouvelle facture.",
      behaviour: [
        "`PUT /provider-invoices/{id}` vérifié sur une instance réelle avec `resourceId` (ressource changée puis remise, autres champs intacts) ; `provider` non vérifié.",
        "`provider` envoie `providerCompany` et `providerContact` ensemble (la doc de l'API les exige ensemble) ; `provider: null` retire les deux.",
        "`payments` (doc de l'API, non vérifié) : enregistré quand la facture a une ressource et que la requête la valide, ou seul pour une facture sans ressource ; remplacement ou ajout à la liste existante non vérifié, relire la facture.",
        "`paidDate` et `dueDate` ne figurent pas dans la doc de modification : l'API peut les ignorer, relire la facture.",
        "`mainManagerId`, `agencyId`, `poleId` / `billingDetailId` (`null` retire), `stateReason`, devise et taux suivent la doc de l'API, non vérifiés.",
      ],
      returns: "confirmation et fiche de la facture fournisseur modifiée.",
    }),
  });
  registerDeleteTool(server, OPTS, { title: "Supprimer une facture fournisseur" });
}
