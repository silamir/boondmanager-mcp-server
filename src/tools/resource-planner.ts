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

/** One planner row: its labels (project or resource, delivery, …) then the counters. */
export type PlannerRow = Record<string, unknown> & { days: number; dates: string[]; comments?: string[] };

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Drop absent and empty values: BoondManager sends `title: ""`, `batch: null`. */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

function personName(ref: Ref | undefined): string | undefined {
  const name = [ref?.firstName, ref?.lastName].filter(Boolean).join(" ");
  return name || ref?.id;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

type GroupBy = "project" | "resource";

function rowKey(t: PlannedTime, by: GroupBy): string {
  const who = by === "project" ? t.project?.id : t.resource?.id;
  return [t.row, t.delivery?.id, t.batch?.id, t.workUnitType?.name, who].map((v) => v ?? "").join("|");
}

function rowLabels(t: PlannedTime, by: GroupBy): Record<string, unknown> {
  const d = t.delivery;
  return compact({
    [by]: by === "project" ? (t.project?.reference ?? t.project?.id) : personName(t.resource),
    delivery: d ? compact({ id: d.id, title: d.title, startDate: d.startDate, endDate: d.endDate }) : undefined,
    opportunity: t.opportunity?.reference,
    workUnitType: t.workUnitType?.name,
  });
}

interface Accumulator {
  labels: Record<string, unknown>;
  days: number;
  dates: string[];
  comments: string[];
}

function accumulate(acc: Accumulator, t: PlannedTime): void {
  acc.days = round(acc.days + (t.duration ?? 0));
  if (t.startDate) acc.dates.push(t.startDate);
  if (t.comment) acc.comments.push(`${t.startDate ?? "?"}: ${t.comment}`);
}

/**
 * Collapse the one-entry-per-day `plannedTimes` into one line per planner row
 * (a project × delivery × work-unit line of the grid), with its total and the
 * planned dates. A month of a full-time resource is ~20 entries per row, each
 * repeating the same project / delivery / opportunity objects.
 */
export function groupPlannedTimes(times: PlannedTime[], by: GroupBy): PlannerRow[] {
  const groups = new Map<string, Accumulator>();
  for (const t of times) {
    const key = rowKey(t, by);
    let acc = groups.get(key);
    if (!acc) {
      acc = { labels: rowLabels(t, by), days: 0, dates: [], comments: [] };
      groups.set(key, acc);
    }
    accumulate(acc, t);
  }
  // Labels first so the rendered JSON reads "project, delivery, …, days, dates".
  return [...groups.values()].map(({ labels, days, dates, comments }) => ({
    ...labels,
    days,
    dates: dates.sort(),
    ...(comments.length > 0 ? { comments } : {}),
  }));
}

function includedOf(response: { included?: unknown }, type: string): Included[] {
  return asArray<Included>(response.included).filter((i) => i.type === type);
}

function singleId(rel: Included["relationships"], name: string): string | undefined {
  const data = rel?.[name]?.data;
  return data && !Array.isArray(data) ? data.id : undefined;
}

const PROJECT_FIGURES = ["signedTime", "takenTimeToJ", "plannedTimeFromJ", "workUnitRate", "mode", "typeOf"];

/** Monthly figures BoondManager computes per project (signed / consumed / still planned). */
function projectFigures(response: { included?: unknown }): Array<Record<string, unknown>> {
  const companies = new Map(includedOf(response, "company").map((c) => [c.id, c.attributes?.name]));
  return includedOf(response, "appresourceplannerproject").map((p) => {
    const a = p.attributes ?? {};
    const companyId = singleId(p.relationships, "company");
    return compact({
      id: p.id,
      reference: a.reference,
      company: companyId ? companies.get(companyId) : undefined,
      ...Object.fromEntries(PROJECT_FIGURES.map((k) => [k, a[k]])),
    });
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

/** Shared shape of both summaries: header fields, grand total, grouped rows, extras. */
function summarise(
  response: PlannerResponse,
  by: GroupBy,
  header: (a: Record<string, unknown>) => Record<string, unknown>,
  extras: (a: Record<string, unknown>) => Record<string, unknown> = () => ({})
): string {
  const entity = entityOf(response);
  if (!entity) return "Planning non trouvé.";
  const a = entity.attributes;
  const rows = groupPlannedTimes(asArray<PlannedTime>(a.plannedTimes), by);
  return render({
    id: entity.id,
    ...header(a),
    term: a.term,
    validationDate: a.validationDate,
    totalPlannedDays: round(rows.reduce((sum, r) => sum + r.days, 0)),
    rows,
    ...extras(a),
  });
}

export function summariseResourcePlanning(response: PlannerResponse): string {
  return summarise(
    response,
    "project",
    (a) => ({ resource: personName({ firstName: a.firstName, lastName: a.lastName } as Ref) }),
    (a) => ({ absencesTimes: asArray(a.absencesTimes), projects: projectFigures(response) })
  );
}

export function summariseProjectPlanning(response: PlannerResponse): string {
  return summarise(response, "resource", (a) => ({ reference: a.reference, workUnitRate: a.workUnitRate }));
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
