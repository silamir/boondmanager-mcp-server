import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OrderSearchSchema, OrderCreateSchema, OrderUpdateSchema } from "../schemas/index.js";
import { apiRequest } from "../services/boond-client.js";
import type { JsonApiResource, JsonApiResponse } from "../types.js";
import {
  buildJsonApiBody,
  registerSearchTool,
  registerGetTool,
  registerCreateTool,
  registerUpdateTool,
  registerDeleteTool,
} from "./crud-factory.js";
import {
  composeDescription,
  defaultCreateDescription,
  defaultDeleteDescription,
  defaultUpdateDescription,
} from "./description-builders.js";
import { registerTabTools } from "./tab-tools.js";
import type { TabDefinition } from "./tab-tools.js";

const OPTS = {
  entityName: "bon de commande",
  entityNamePlural: "bons de commande",
  apiPath: "/orders",
  prefix: "boond_orders",
};

// `ENTITY_TABS.orders` — verified live on 2026-09-26 (issue #258).
const ORDER_TABS: TabDefinition[] = [
  {
    name: "information",
    tab: "information",
    title: "Informations complètes d'un bon de commande",
    subject: "les informations complètes",
    content: "période, conditions de paiement, références acheteur, prestations et projet liés",
    returns: "Fiche complète du bon de commande (relations société, contact, projet, prestations incluses).",
  },
  {
    name: "actions",
    tab: "actions",
    title: "Actions liées à un bon de commande",
    subject: "les actions",
    content: "envois, relances, notes",
    returns: "Liste des actions rattachées au bon de commande.",
  },
  {
    name: "invoices",
    tab: "invoices",
    title: "Factures d'un bon de commande",
    subject: "les factures émises",
    content: "référence, période, état, montants HT/TTC",
    returns:
      "Liste des factures rattachées au bon de commande, précédée des totaux calculés par BoondManager : commandé HT, facturé HT/TTC, reste à facturer (`deltaInvoicedExcludingTax`) et répartition par état.",
    behaviour: [
      "C'est l'entrée de la préparation de facturation : `deltaInvoicedExcludingTax` > 0 signifie qu'il reste à facturer sur la commande.",
    ],
  },
];

interface DeliveryPurchaseRef {
  type: "delivery" | "purchase";
  id: string;
}

/** Maps convenience inputs and schedule shortcuts to the Boond JSON:API body. */
export function buildOrderBody(params: Record<string, unknown>): unknown {
  const { id, companyId, projectId, deliveriesPurchases, ...rest } = params;
  const body = buildJsonApiBody("order", orderAttributes(rest), id as string | undefined, {
    company: companyId ? { id: String(companyId), type: "company" } : undefined,
    project: projectId ? { id: String(projectId), type: "project" } : undefined,
  }) as { data: Record<string, unknown> };
  if (Array.isArray(deliveriesPurchases)) {
    // `uniqueItems` in the RAML: drop duplicates rather than let the API refuse the body.
    const seen = new Set<string>();
    const refs = (deliveriesPurchases as DeliveryPurchaseRef[]).filter((ref) => {
      const key = `${ref.type}:${ref.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const relationships = (body.data["relationships"] ?? {}) as Record<string, unknown>;
    relationships["deliveriesPurchases"] = {
      data: refs.map((ref) => ({ id: String(ref.id), type: ref.type })),
    };
    body.data["relationships"] = relationships;
  }
  return body;
}

type RelationData = { id: string; type: string } | { id: string; type: string }[] | null | undefined;

function relationIds(data: RelationData): { id: string; type: string }[] {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * One line per delivery / purchase, in the shape the BoondManager UI uses in
 * its "Prestations / Achats corrélés" block: `NOM Prénom - début - fin - MIS<id>`
 * for a delivery (title in parentheses), `ACH<id> - titre - début - fin` for a
 * purchase. Names come from the `included` resources of `/information`.
 */
function describeDeliveryPurchase(item: JsonApiResource, resources: Map<string, JsonApiResource>): string {
  const a = item.attributes ?? {};
  const period = [text(a["startDate"]), text(a["endDate"])].filter((p): p is string => p !== undefined).join(" - ");
  if (item.type === "purchase") {
    const reference = text(a["reference"]) ?? `ACH${item.id}`;
    return [`purchase #${item.id} : ${reference}`, text(a["title"]), period || undefined]
      .filter((p): p is string => p !== undefined)
      .join(" - ");
  }
  const owner = relationIds(item.relationships?.["dependsOn"]?.data).find((r) => r.type === "resource");
  const resource = owner ? resources.get(owner.id) : undefined;
  const name = resource
    ? [text(resource.attributes["lastName"]), text(resource.attributes["firstName"])]
        .filter((p): p is string => p !== undefined)
        .join(" ")
    : undefined;
  const label = [name, period || undefined, `MIS${item.id}`].filter((p): p is string => p !== undefined).join(" - ");
  const title = text(a["title"]);
  return `delivery #${item.id} : ${label}${title ? ` (${title})` : ""}`;
}

/** Bounds the candidate list: this text is appended after `CHARACTER_LIMIT` has been applied to the record. */
const MAX_LISTED_CANDIDATES = 40;

function overlaps(item: JsonApiResource, start?: string, end?: string): boolean {
  const a = item.attributes ?? {};
  const itemStart = text(a["startDate"]);
  const itemEnd = text(a["endDate"]);
  if (!start || !end || !itemStart || !itemEnd) return true;
  return itemStart <= end && itemEnd >= start;
}

/**
 * Renders the correlated deliveries / purchases of an order from its
 * `GET /orders/{id}/information` response: `relationships.deliveriesPurchases`
 * holds the ticked ones, `included` every delivery and purchase of the project
 * (the UI's checkbox list). Verified on a production read, 2026-11-26.
 */
export function formatCorrelatedDeliveriesPurchases(info: JsonApiResponse): string {
  const order = Array.isArray(info.data) ? info.data[0] : info.data;
  const included = info.included ?? [];
  const resources = new Map(included.filter((i) => i.type === "resource").map((i) => [i.id, i]));
  const candidates = included.filter((i) => i.type === "delivery" || i.type === "purchase");
  const byKey = new Map(candidates.map((i) => [`${i.type}:${i.id}`, i]));
  const ticked = relationIds(order?.relationships?.["deliveriesPurchases"]?.data);
  const tickedKeys = new Set(ticked.map((r) => `${r.type}:${r.id}`));

  const lines = ["Prestations / achats corrélés (`deliveriesPurchases`, lu sur /orders/{id}/information) :"];
  if (ticked.length === 0) lines.push("- aucun");
  for (const ref of ticked) {
    const item = byKey.get(`${ref.type}:${ref.id}`);
    lines.push(`- ${item ? describeDeliveryPurchase(item, resources) : `${ref.type} #${ref.id}`}`);
  }

  const start = text(order?.attributes?.["startDate"]);
  const end = text(order?.attributes?.["endDate"]);
  const others = candidates.filter((i) => !tickedKeys.has(`${i.type}:${i.id}`));
  const inPeriod = others.filter((i) => overlaps(i, start, end));
  const shown = inPeriod.slice(0, MAX_LISTED_CANDIDATES);
  const window = start && end ? ` dont la période recoupe celle de la commande (${start} → ${end})` : "";
  lines.push("", `Autres prestations / achats du projet, non corrélés${window} :`);
  if (shown.length === 0) lines.push("- aucun");
  for (const item of shown) lines.push(`- ${describeDeliveryPurchase(item, resources)}`);
  if (inPeriod.length > shown.length) {
    lines.push(`(${inPeriod.length - shown.length} autre(s) non listé(s) : voir \`boond_orders_information\`)`);
  }
  const hidden = others.length - inPeriod.length;
  if (hidden > 0) lines.push(`(${hidden} autre(s) hors de la période de la commande, non listé(s))`);
  return lines.join("\n");
}

async function correlatedSection(id: string): Promise<string> {
  try {
    return formatCorrelatedDeliveriesPurchases(await apiRequest(`/orders/${id}/information`));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `Prestations / achats corrélés : lecture de /orders/${id}/information impossible (${reason}).`;
  }
}

const DELIVERIES_PURCHASES_WRITE = [
  '`deliveriesPurchases` (prestations / achats corrélés, `{ type: "delivery" | "purchase", id }`) est **supposé remplacer toute la liste**, comme toute relation JSON:API multiple : relire d\'abord avec `boond_orders_get` (section « Prestations / achats corrélés »), fusionner, puis renvoyer la liste complète. Omettre le champ n\'envoie rien.',
  "Écriture de `deliveriesPurchases` **non vérifiée** : nom et forme tirés de la doc RAML (`relationships.deliveriesPurchases`), jamais exercés sur un bac à sable ; le remplacement de la liste et l'effet de `[]` (décorréler tout ?) sont des suppositions. Relire la commande après écriture.",
];

function normalizeSchedules(schedules?: Array<Record<string, unknown>>): Array<Record<string, unknown>> | undefined {
  return schedules?.map((schedule) => {
    const amount =
      typeof schedule.amountExcludingTax === "number"
        ? schedule.amountExcludingTax
        : typeof schedule.turnoverTermOfPaymentExcludingTax === "number"
          ? schedule.turnoverTermOfPaymentExcludingTax
          : undefined;
    return {
      ...(typeof schedule.id === "string" ? { id: schedule.id } : {}),
      date: schedule.date ?? schedule.endDate ?? schedule.startDate,
      title: schedule.title ?? "Echeance",
      turnoverQuotaExcludingTax: schedule.turnoverQuotaExcludingTax ?? amount ?? 0,
      turnoverTermOfPaymentExcludingTax: schedule.turnoverTermOfPaymentExcludingTax ?? amount ?? 0,
      forceTermOfPaymentExcludingTax: schedule.forceTermOfPaymentExcludingTax ?? true,
    };
  });
}

function orderAttributes(params: Record<string, unknown>): Record<string, unknown> {
  const { reference, orderDate, amountExcludingTax, schedules, note, ...attrs } = params;
  return {
    ...attrs,
    ...(reference ? { number: reference } : {}),
    ...(orderDate ? { date: orderDate } : {}),
    ...(amountExcludingTax !== undefined ? { turnoverOrderedExcludingTax: amountExcludingTax } : {}),
    ...(Array.isArray(schedules) ? { schedules: normalizeSchedules(schedules as Array<Record<string, unknown>>) } : {}),
    ...(note ? { informationComments: note } : {}),
  };
}

export function registerOrderTools(server: McpServer): void {
  registerSearchTool(server, OPTS, {
    schema: OrderSearchSchema,
    description: `Recherche des bons de commande dans BoondManager avec filtres par société et projet.

\`companyId\` / \`projectId\` sont convertis en références \`keywords\` (CSOC<id> / PRJ<id>) : l'API n'a pas de paramètre dédié.

Returns: Liste des bons de commande correspondants.`,
  });
  registerGetTool(server, OPTS, {
    withTab: false,
    appendSection: correlatedSection,
    description: composeDescription({
      purpose: "Récupère la fiche d'un bon de commande par son ID, avec ses prestations et achats corrélés.",
      when: "après un `boond_orders_search`, pour la fiche et la liste des prestations / achats corrélés à la commande.",
      instead:
        "`boond_orders_search` si l'ID n'est pas connu ; `boond_orders_information` pour toutes les informations de facturation.",
      behaviour: [
        "La corrélation n'existe pas sur `GET /orders/{id}` : elle est lue en plus sur `GET /orders/{id}/information` (un appel de plus) et ajoutée sous la fiche, avec les autres prestations / achats du projet qui recoupent la période de la commande, pour savoir quels ID corréler.",
        "Un ID inconnu remonte l'erreur BoondManager telle quelle : l'ID doit venir de `boond_orders_search`, jamais d'une supposition.",
      ],
      returns:
        "JSON de la fiche tel que renvoyé par l'API, puis la section « Prestations / achats corrélés » (`delivery #id : NOM Prénom - début - fin - MIS<id>`, `purchase #id : ACH<id> - titre`). Lecture seule.",
    }),
  });
  registerCreateTool(server, OPTS, OrderCreateSchema, buildOrderBody, {
    description: defaultCreateDescription(OPTS, DELIVERIES_PURCHASES_WRITE),
  });
  // Updates go through PUT /orders/{id}/information — the base resource
  // returns 405 on PATCH (issue #134, same root cause as #124).
  registerUpdateTool(server, OPTS, OrderUpdateSchema, buildOrderBody, {
    method: "PUT",
    pathSuffix: "information",
    description: defaultUpdateDescription(OPTS, DELIVERIES_PURCHASES_WRITE),
  });
  registerDeleteTool(server, OPTS, {
    title: "Supprimer un bon de commande",
    description: defaultDeleteDescription({
      entityName: "bon de commande",
      entityNamePlural: "bons de commande",
      prefix: "boond_orders",
    }),
  });

  registerTabTools(server, OPTS, ORDER_TABS);
}
