import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EntityIdSchema } from "../schemas/index.js";
import { apiRequest } from "../services/boond-client.js";
import { API_PATHS, CHARACTER_LIMIT } from "../constants.js";

/**
 * Resource Planner app (`ui.boondmanager.com/apps/resource-planner/...`).
 *
 * Not in the public RAML: the routes were read from the app's own network
 * traffic and verified live (2026-11-27, read-only) with the server's JWT
 * client credentials:
 *
 *   GET /apps/resource-planner/resources/{resourceId}_{YYYY-MM}
 *   GET /apps/resource-planner/projects/{projectId}_{YYYY-MM}
 *
 * There is no list route (`/apps/resource-planner/resources` 404s) and the
 * month is part of the id. BoondManager normalises an out-of-range month
 * (`2027-13` answers `2028-01`), so the schema rejects it up front. The app
 * also writes (a save button), but that path is not exposed: it was never
 * exercised and the reachable tenant is production.
 */

/** `YYYY-MM`, month 01..12 — an invalid month would silently roll over. */
export const PlannerMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mois attendu au format AAAA-MM (ex. 2027-01)")
  .describe("Mois planifié, format AAAA-MM (ex. 2027-01)");

export const ResourcePlannerResourceSchema = z
  .object({
    resourceId: EntityIdSchema.describe("ID de la ressource (collaborateur)"),
    month: PlannerMonthSchema,
  })
  .strict();

export const ResourcePlannerProjectSchema = z
  .object({
    projectId: EntityIdSchema.describe("ID du projet"),
    month: PlannerMonthSchema,
  })
  .strict();

interface Ref {
  id?: string;
  reference?: string;
  title?: string;
  firstName?: string;
  lastName?: string;
  startDate?: string;
  endDate?: string;
}

interface PlannedTime {
  id?: string;
  startDate?: string;
  duration?: number;
  row?: number;
  comment?: string;
  workUnitType?: { name?: string; activityType?: string };
  resource?: Ref;
  project?: Ref;
  delivery?: Ref | null;
  batch?: Ref | null;
  opportunity?: Ref | null;
}

interface Included {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string; type: string } | Array<{ id: string; type: string }> | null }>;
}

interface PlannerRow {
  project?: string;
  resource?: string;
  delivery?: { id?: string; title?: string; startDate?: string; endDate?: string };
  opportunity?: string;
  workUnitType?: string;
  days: number;
  dates: string[];
  comments?: string[];
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function personName(ref: Ref | undefined): string | undefined {
  if (!ref) return undefined;
  const name = [ref.firstName, ref.lastName].filter(Boolean).join(" ");
  return name || ref.id;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Collapse the one-entry-per-day `plannedTimes` into one line per planner row
 * (a project × delivery × work-unit line of the grid), with its total and the
 * planned dates. A month of a full-time resource is ~20 entries per row, each
 * repeating the same project / delivery / opportunity objects.
 */
export function groupPlannedTimes(times: PlannedTime[], by: "project" | "resource"): PlannerRow[] {
  const rows = new Map<string, PlannerRow>();
  for (const t of times) {
    const key = `${t.row ?? ""}|${t.delivery?.id ?? ""}|${t.batch?.id ?? ""}|${t.workUnitType?.name ?? ""}|${
      by === "project" ? (t.project?.id ?? "") : (t.resource?.id ?? "")
    }`;
    let row = rows.get(key);
    if (!row) {
      const label = by === "project" ? (t.project?.reference ?? t.project?.id) : personName(t.resource);
      // Label first so the rendered JSON reads "project, delivery, …, days, dates".
      row = { ...(label !== undefined ? { [by]: label } : {}), days: 0, dates: [] };
      if (t.delivery) {
        const delivery: NonNullable<PlannerRow["delivery"]> = {};
        if (t.delivery.id) delivery.id = t.delivery.id;
        if (t.delivery.title) delivery.title = t.delivery.title;
        if (t.delivery.startDate) delivery.startDate = t.delivery.startDate;
        if (t.delivery.endDate) delivery.endDate = t.delivery.endDate;
        row.delivery = delivery;
      }
      if (t.opportunity?.reference) row.opportunity = t.opportunity.reference;
      if (t.workUnitType?.name) row.workUnitType = t.workUnitType.name;
      // Re-append the counters after the labels for a readable key order.
      const { days, dates, ...labels } = row;
      row = { ...labels, days, dates };
      rows.set(key, row);
    }
    row.days = round(row.days + (typeof t.duration === "number" ? t.duration : 0));
    if (t.startDate) row.dates.push(t.startDate);
    if (t.comment) (row.comments ??= []).push(`${t.startDate ?? "?"}: ${t.comment}`);
  }
  for (const row of rows.values()) row.dates.sort();
  return [...rows.values()];
}

function includedOf(response: { included?: unknown }, type: string): Included[] {
  return asArray<Included>(response.included).filter((i) => i.type === type);
}

function nameById(response: { included?: unknown }, type: string, attr = "name"): Map<string, string> {
  const map = new Map<string, string>();
  for (const i of includedOf(response, type)) {
    const v = i.attributes?.[attr];
    if (typeof v === "string") map.set(i.id, v);
  }
  return map;
}

/** Monthly figures BoondManager computes per project (signed / consumed / still planned). */
function projectFigures(response: { included?: unknown }): Array<Record<string, unknown>> {
  const companies = nameById(response, "company");
  return includedOf(response, "appresourceplannerproject").map((p) => {
    const a = p.attributes ?? {};
    const companyRel = p.relationships?.company?.data;
    const companyId = companyRel && !Array.isArray(companyRel) ? companyRel.id : undefined;
    const out: Record<string, unknown> = { id: p.id, reference: a.reference };
    const company = companyId ? companies.get(companyId) : undefined;
    if (company) out.company = company;
    for (const k of ["signedTime", "takenTimeToJ", "plannedTimeFromJ", "workUnitRate", "mode", "typeOf"]) {
      if (a[k] !== undefined) out[k] = a[k];
    }
    return out;
  });
}

function render(payload: unknown): string {
  const text = JSON.stringify(payload, null, 2);
  return text.length > CHARACTER_LIMIT ? text.substring(0, CHARACTER_LIMIT) + "\n\n[Résultat tronqué...]" : text;
}

interface PlannerResponse {
  data?: { id?: string; attributes?: Record<string, unknown>; relationships?: Included["relationships"] } | unknown[];
  included?: unknown;
}

function entityOf(response: PlannerResponse): { id?: string; attributes: Record<string, unknown> } | undefined {
  const data = Array.isArray(response.data) ? response.data[0] : response.data;
  if (!data || typeof data !== "object") return undefined;
  const d = data as { id?: string; attributes?: Record<string, unknown> };
  return { ...(d.id !== undefined ? { id: d.id } : {}), attributes: d.attributes ?? {} };
}

export function summariseResourcePlanning(response: PlannerResponse): string {
  const entity = entityOf(response);
  if (!entity) return "Planning non trouvé.";
  const a = entity.attributes;
  const times = asArray<PlannedTime>(a.plannedTimes);
  const rows = groupPlannedTimes(times, "project");
  return render({
    id: entity.id,
    resource: [a.firstName, a.lastName].filter(Boolean).join(" ") || undefined,
    term: a.term,
    validationDate: a.validationDate,
    totalPlannedDays: round(rows.reduce((s, r) => s + r.days, 0)),
    rows,
    absencesTimes: asArray(a.absencesTimes),
    projects: projectFigures(response),
  });
}

export function summariseProjectPlanning(response: PlannerResponse): string {
  const entity = entityOf(response);
  if (!entity) return "Planning non trouvé.";
  const a = entity.attributes;
  const times = asArray<PlannedTime>(a.plannedTimes);
  const rows = groupPlannedTimes(times, "resource");
  return render({
    id: entity.id,
    reference: a.reference,
    term: a.term,
    validationDate: a.validationDate,
    workUnitRate: a.workUnitRate,
    totalPlannedDays: round(rows.reduce((s, r) => s + r.days, 0)),
    rows,
  });
}

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function registerResourcePlannerTools(server: McpServer): void {
  server.registerTool(
    "boond_resource_planner_resource",
    {
      title: "Plan de charge mensuel d'une ressource",
      description: `Lit le plan de charge d'une ressource pour un mois dans l'app Resource Planner : les jours planifiés par projet / prestation, avec les chiffres du projet (signé, consommé, reste planifié).

Quand : pour savoir sur quoi un collaborateur est planifié un mois donné, y compris dans le futur (staffing prévisionnel).
Plutôt que : \`boond_resources_projects\` qui liste les missions sans le détail jour par jour, \`boond_timesheets_search\` pour le temps réellement saisi (CRA), \`boond_planning_absences_search\` pour les absences.

Le mois fait partie de l'identifiant ; il n'existe pas de recherche transverse. Route de l'app Resource Planner, absente de la RAML publique (lecture vérifiée).

Returns : JSON { id, resource, term, validationDate, totalPlannedDays, rows: [{ project, delivery, opportunity, workUnitType, days, dates }], absencesTimes, projects: [{ reference, company, signedTime, takenTimeToJ, plannedTimeFromJ }] }.`,
      inputSchema: ResourcePlannerResourceSchema,
      annotations: READ_ANNOTATIONS,
    },
    async (params) => {
      const response = await apiRequest(`${API_PATHS.resourcePlannerResources}/${params.resourceId}_${params.month}`);
      return { content: [{ type: "text" as const, text: summariseResourcePlanning(response) }] };
    }
  );

  server.registerTool(
    "boond_resource_planner_project",
    {
      title: "Plan de charge mensuel d'un projet",
      description: `Lit le plan de charge d'un projet pour un mois dans l'app Resource Planner : les jours planifiés par ressource et par prestation.

Quand : pour voir qui est planifié sur un projet un mois donné, et combien de jours.
Plutôt que : \`boond_resource_planner_resource\` pour la vue d'un collaborateur sur tous ses projets, \`boond_projects_get\` pour la fiche du projet.

Le mois fait partie de l'identifiant ; il n'existe pas de recherche transverse. Route de l'app Resource Planner, absente de la RAML publique (lecture vérifiée).

Returns : JSON { id, reference, term, validationDate, workUnitRate, totalPlannedDays, rows: [{ resource, delivery, opportunity, workUnitType, days, dates }] }.`,
      inputSchema: ResourcePlannerProjectSchema,
      annotations: READ_ANNOTATIONS,
    },
    async (params) => {
      const response = await apiRequest(`${API_PATHS.resourcePlannerProjects}/${params.projectId}_${params.month}`);
      return { content: [{ type: "text" as const, text: summariseProjectPlanning(response) }] };
    }
  );
}
