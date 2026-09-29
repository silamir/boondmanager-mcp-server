import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCandidateTools } from "./candidates.js";
import * as boondClient from "../services/boond-client.js";

function createMockServer() {
  return {
    registerTool: vi.fn(),
  } as unknown as McpServer;
}

function getHandler(server: McpServer, name: string) {
  const call = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === name);
  if (!call) throw new Error(`tool ${name} not registered`);
  return call[2] as (params: unknown) => Promise<unknown>;
}

describe("registerCandidateTools", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMockServer();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates via PUT /candidates/{id}/information (issue #134)", async () => {
    registerCandidateTools(server);
    const apiSpy = vi
      .spyOn(boondClient, "apiRequest")
      .mockResolvedValue({ data: { id: "4012", type: "candidate", attributes: {} } } as never);

    const handler = getHandler(server, "boond_candidates_update");
    await handler({ id: "4012", phone1: "+33769594357" });

    const [path, method] = apiSpy.mock.calls[0];
    // The base resource returns 405 on PATCH; updates target the
    // /information sub-resource with PUT.
    expect(path).toBe("/candidates/4012/information");
    expect(method).toBe("PUT");
  });

  it("should register CRUD tools + 5 tab tools + 2 tab-write tools = 12 total", () => {
    registerCandidateTools(server);
    expect(server.registerTool).toHaveBeenCalledTimes(12);
  });

  describe("boond_candidates_technical_data_update", () => {
    it("reads the current DT then PUTs the merged payload in merge mode", async () => {
      registerCandidateTools(server);
      const apiSpy = vi.spyOn(boondClient, "apiRequest").mockImplementation(async (_path, method) => {
        if (method === undefined || method === "GET") {
          return {
            data: {
              id: "25075",
              type: "candidate",
              attributes: { skills: "Integration", activityAreas: ["systemengineer"], experience: 2 },
            },
          } as never;
        }
        return {
          data: {
            id: "25075",
            type: "candidate",
            attributes: { skills: "Integration", activityAreas: ["systemengineer", "hardwareengineer"], experience: 2 },
          },
        } as never;
      });

      const handler = getHandler(server, "boond_candidates_technical_data_update");
      const res = (await handler({
        id: "25075",
        mode: "merge",
        activityAreas: ["hardwareengineer", "systemengineer"],
        experience: 3,
      })) as { content: Array<{ text: string }> };

      expect(apiSpy.mock.calls[0][0]).toBe("/candidates/25075/technical-data");
      const [path, method, body] = apiSpy.mock.calls[1] as [
        string,
        string,
        { data: { type: string; attributes: Record<string, unknown> } },
      ];
      expect(path).toBe("/candidates/25075/technical-data");
      expect(method).toBe("PUT");
      expect(body.data.type).toBe("candidate");
      // merge: area appended once, experience untouched because already set
      expect(body.data.attributes.activityAreas).toEqual(["systemengineer", "hardwareengineer"]);
      expect(body.data.attributes).not.toHaveProperty("experience");
      expect(res.content[0].text).not.toContain("non confirmés");
    });

    it("PUTs the raw payload without a prior read in replace mode", async () => {
      registerCandidateTools(server);
      const apiSpy = vi
        .spyOn(boondClient, "apiRequest")
        .mockResolvedValue({ data: { id: "1", type: "candidate", attributes: { experience: 3 } } } as never);
      const handler = getHandler(server, "boond_candidates_technical_data_update");
      await handler({ id: "1", mode: "replace", experience: 3 });
      expect(apiSpy).toHaveBeenCalledTimes(1);
      expect(apiSpy.mock.calls[0][1]).toBe("PUT");
    });

    it("warns when the API does not echo a written field", async () => {
      registerCandidateTools(server);
      vi.spyOn(boondClient, "apiRequest").mockResolvedValue({
        data: { id: "1", type: "candidate", attributes: { experience: 1 } },
      } as never);
      const handler = getHandler(server, "boond_candidates_technical_data_update");
      const res = (await handler({ id: "1", mode: "replace", experience: 3, summary: "x" })) as {
        content: Array<{ text: string }>;
      };
      expect(res.content[0].text).toContain("non confirmés");
      expect(res.content[0].text).toContain("experience, summary");
    });
  });

  describe("boond_candidates_administrative_update", () => {
    it("PUTs only the supplied fields to /candidates/{id}/administrative", async () => {
      registerCandidateTools(server);
      const apiSpy = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({
        data: { id: "7", type: "candidate", attributes: { desiredSalary: { min: 50000, max: 55000 } } },
      } as never);
      const handler = getHandler(server, "boond_candidates_administrative_update");
      await handler({ id: "7", desiredSalary: { min: 50000, max: 55000 } });
      const [path, method, body] = apiSpy.mock.calls[0] as [
        string,
        string,
        { data: { attributes: Record<string, unknown> } },
      ];
      expect(path).toBe("/candidates/7/administrative");
      expect(method).toBe("PUT");
      expect(body.data.attributes).toEqual({ desiredSalary: { min: 50000, max: 55000 } });
    });

    it("does not call the API when no field is supplied", async () => {
      registerCandidateTools(server);
      const apiSpy = vi.spyOn(boondClient, "apiRequest");
      const handler = getHandler(server, "boond_candidates_administrative_update");
      await handler({ id: "7" });
      expect(apiSpy).not.toHaveBeenCalled();
    });
  });

  it("should register all CRUD tools", () => {
    registerCandidateTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_candidates_search");
    expect(names).toContain("boond_candidates_get");
    expect(names).toContain("boond_candidates_create");
    expect(names).toContain("boond_candidates_update");
    expect(names).toContain("boond_candidates_delete");
  });

  it("should register all 5 tab tools", () => {
    registerCandidateTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_candidates_information");
    expect(names).toContain("boond_candidates_technical_data");
    expect(names).toContain("boond_candidates_administrative");
    expect(names).toContain("boond_candidates_actions");
    expect(names).toContain("boond_candidates_positionings");
  });

  it("should register tab tools as readOnly and non-destructive", () => {
    registerCandidateTools(server);
    const tabCalls = vi
      .mocked(server.registerTool)
      .mock.calls.filter(
        (c) =>
          typeof c[0] === "string" &&
          [
            "boond_candidates_information",
            "boond_candidates_technical_data",
            "boond_candidates_administrative",
            "boond_candidates_actions",
            "boond_candidates_positionings",
          ].includes(c[0] as string)
      );

    expect(tabCalls).toHaveLength(5);
    for (const call of tabCalls) {
      const [, metadata] = call;
      expect(metadata.annotations?.readOnlyHint).toBe(true);
      expect(metadata.annotations?.destructiveHint).toBe(false);
    }
  });
});
