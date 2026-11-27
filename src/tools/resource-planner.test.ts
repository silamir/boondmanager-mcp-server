import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiRequest } from "../services/boond-client.js";
import {
  registerResourcePlannerTools,
  groupPlannedTimes,
  summariseResourcePlanning,
  summariseProjectPlanning,
  ResourcePlannerResourceSchema,
  ResourcePlannerProjectSchema,
} from "./resource-planner.js";

vi.mock("../services/boond-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/boond-client.js")>();
  return { ...actual, apiRequest: vi.fn() };
});

type Handler = (params: Record<string, unknown>, extra?: unknown) => Promise<{ content: Array<{ text: string }> }>;

function register() {
  const server = { registerTool: vi.fn() } as unknown as McpServer;
  registerResourcePlannerTools(server);
  const calls = vi.mocked(server.registerTool).mock.calls;
  const byName = new Map(calls.map((c) => [c[0], { config: c[1], handler: c[2] as unknown as Handler }]));
  return { calls, byName };
}

const delivery = { id: "200", title: "", startDate: "2027-01-04", endDate: "2027-12-31" };
const project = { id: "30_2027-01", reference: "PRJ30-Mission" };
const opportunity = { id: "40", reference: "AO40" };
const workUnitType = { reference: 1, activityType: "production", name: "Production" };

function day(id: string, date: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    startDate: date,
    duration: 1,
    row: 7,
    comment: "",
    workUnitRate: 1,
    workUnitType,
    resource: { id: "10" },
    delivery,
    batch: null,
    project,
    opportunity,
    ...extra,
  };
}

// Shape copied from a live GET /apps/resource-planner/resources/{id}_{YYYY-MM} (names anonymised).
const resourceResponse = {
  data: {
    id: "10_2027-01",
    type: "appresourceplannerresource",
    attributes: {
      firstName: "Jane",
      lastName: "DOE",
      workUnitRate: "notUsed",
      term: "2027-01",
      validationDate: "2026-11-27T12:31:25+0100",
      plannedTimes: [
        day("1", "2027-01-05"),
        day("2", "2027-01-04"),
        day("3", "2027-01-06", { duration: 0.5, comment: "matin" }),
        day("4", "2027-01-07", {
          row: 8,
          project: { id: "31_2027-01", reference: "PRJ31-Autre" },
          delivery: { id: "201", title: "Lot 2", startDate: "2026-10-01", endDate: "2027-05-22" },
        }),
      ],
      absencesTimes: [],
    },
    relationships: { projects: { data: [{ id: "30_2027-01", type: "appresourceplannerproject" }] } },
  },
  included: [
    { id: "7", type: "company", attributes: { name: "ACME" } },
    {
      id: "30_2027-01",
      type: "appresourceplannerproject",
      attributes: {
        reference: "PRJ30-Mission",
        mode: 1,
        typeOf: 1,
        workUnitRate: 1,
        signedTime: 207,
        takenTimeToJ: 0,
        plannedTimeFromJ: 207,
        canReadProject: true,
      },
      relationships: { company: { data: { id: "7", type: "company" } } },
    },
  ],
};

describe("registerResourcePlannerTools", () => {
  beforeEach(() => vi.mocked(apiRequest).mockReset());

  it("registers two read-only tools", () => {
    const { calls, byName } = register();
    expect(calls).toHaveLength(2);
    for (const name of ["boond_resource_planner_resource", "boond_resource_planner_project"]) {
      const tool = byName.get(name);
      expect(tool, name).toBeDefined();
      expect(tool?.config.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    }
  });

  it("resource tool GETs the composite {resourceId}_{month} id and summarises it", async () => {
    vi.mocked(apiRequest).mockResolvedValue(resourceResponse);
    const tool = register().byName.get("boond_resource_planner_resource");
    const result = await tool?.handler({ resourceId: "10", month: "2027-01" });
    expect(apiRequest).toHaveBeenCalledWith("/apps/resource-planner/resources/10_2027-01");
    const json = JSON.parse(result?.content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(json).toMatchObject({ resource: "Jane DOE", term: "2027-01", totalPlannedDays: 3.5 });
    expect(json.projects).toEqual([
      {
        id: "30_2027-01",
        reference: "PRJ30-Mission",
        company: "ACME",
        signedTime: 207,
        takenTimeToJ: 0,
        plannedTimeFromJ: 207,
        workUnitRate: 1,
        mode: 1,
        typeOf: 1,
      },
    ]);
  });

  it("project tool GETs the composite {projectId}_{month} id", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      data: {
        id: "30_2027-01",
        attributes: {
          reference: "PRJ30-Mission",
          term: "2027-01",
          plannedTimes: [
            day("1", "2027-01-04", { resource: { id: "10_2027-01", firstName: "Jane", lastName: "DOE" } }),
          ],
        },
      },
    });
    const tool = register().byName.get("boond_resource_planner_project");
    const result = await tool?.handler({ projectId: "30", month: "2027-01" });
    expect(apiRequest).toHaveBeenCalledWith("/apps/resource-planner/projects/30_2027-01");
    const json = JSON.parse(result?.content[0]?.text ?? "{}") as { rows: Array<Record<string, unknown>> };
    expect(json.rows[0]).toMatchObject({ resource: "Jane DOE", days: 1, dates: ["2027-01-04"] });
  });
});

describe("schemas", () => {
  it("rejects an out-of-range month (BoondManager would roll 2027-13 over to 2028-01)", () => {
    expect(ResourcePlannerResourceSchema.safeParse({ resourceId: "10", month: "2027-13" }).success).toBe(false);
    expect(ResourcePlannerResourceSchema.safeParse({ resourceId: "10", month: "2027-1" }).success).toBe(false);
    expect(ResourcePlannerResourceSchema.safeParse({ resourceId: "10", month: "2027-12" }).success).toBe(true);
  });

  it("rejects a non-numeric id so it cannot reach the path", () => {
    expect(ResourcePlannerProjectSchema.safeParse({ projectId: "30_2027-01", month: "2027-01" }).success).toBe(false);
    expect(ResourcePlannerProjectSchema.safeParse({ projectId: "30", month: "2027-01", extra: 1 }).success).toBe(false);
  });
});

describe("groupPlannedTimes", () => {
  it("collapses one entry per day into one line per planner row, dates sorted", () => {
    const rows = groupPlannedTimes(resourceResponse.data.attributes.plannedTimes, "project");
    expect(rows).toEqual([
      {
        project: "PRJ30-Mission",
        delivery: { id: "200", startDate: "2027-01-04", endDate: "2027-12-31" },
        opportunity: "AO40",
        workUnitType: "Production",
        days: 2.5,
        dates: ["2027-01-04", "2027-01-05", "2027-01-06"],
        comments: ["2027-01-06: matin"],
      },
      {
        project: "PRJ31-Autre",
        delivery: { id: "201", title: "Lot 2", startDate: "2026-10-01", endDate: "2027-05-22" },
        opportunity: "AO40",
        workUnitType: "Production",
        days: 1,
        dates: ["2027-01-07"],
      },
    ]);
  });

  it("tolerates entries without delivery, duration or labels", () => {
    expect(groupPlannedTimes([{ id: "1" }], "resource")).toEqual([{ days: 0, dates: [] }]);
  });
});

describe("summaries", () => {
  it("answer 'not found' when data is missing", () => {
    expect(summariseResourcePlanning({})).toBe("Planning non trouvé.");
    expect(summariseProjectPlanning({ data: [] })).toBe("Planning non trouvé.");
  });

  it("truncate past CHARACTER_LIMIT", () => {
    const many = Array.from({ length: 3000 }, (_, i) =>
      day(String(i), "2027-01-04", { row: i, comment: "x".repeat(20) })
    );
    const text = summariseResourcePlanning({ data: { attributes: { plannedTimes: many } } });
    expect(text).toContain("[Résultat tronqué...]");
  });
});
