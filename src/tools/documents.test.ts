import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDocumentTools } from "./documents.js";
import { apiDownload, apiUploadForm, DownloadTooLargeError } from "../services/boond-client.js";
import { MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES, CHARACTER_LIMIT } from "../constants.js";
import { buildPdf, buildZip } from "../services/document-text.test.js";
import { readLocalUpload, UploadRejectedError } from "../services/upload-source.js";
import { uploadRelay } from "../services/upload-relay.js";
import { DocumentCreateSchema, DocumentParentTypes } from "../schemas/index.js";

vi.mock("../services/upload-relay.js", () => ({
  uploadRelay: { open: vi.fn(), claim: vi.fn() },
}));

vi.mock("../services/upload-source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/upload-source.js")>();
  return { ...actual, readLocalUpload: vi.fn() };
});

vi.mock("../services/boond-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/boond-client.js")>();
  return { ...actual, apiDownload: vi.fn(), apiUploadForm: vi.fn() };
});

function createMockServer() {
  return { registerTool: vi.fn() } as unknown as McpServer;
}

function handlerOf(
  server: McpServer,
  name: string
): (params: unknown) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text?: string; resource?: { uri: string; mimeType: string; blob?: string } }>;
  structuredContent?: Record<string, unknown>;
}> {
  const call = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === name);
  if (!call) throw new Error(`tool ${name} not registered`);
  return call[2] as never;
}

describe("registerDocumentTools", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMockServer();
    vi.mocked(apiDownload).mockReset();
    vi.mocked(apiUploadForm).mockReset();
    vi.mocked(readLocalUpload).mockReset();
    vi.mocked(uploadRelay.open).mockReset();
    vi.mocked(uploadRelay.claim).mockReset();
  });

  it("should register 4 tools", () => {
    registerDocumentTools(server);
    expect(server.registerTool).toHaveBeenCalledTimes(4);
  });

  it("should register all expected tool names", () => {
    registerDocumentTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_documents_get");
    expect(names).toContain("boond_documents_create");
    expect(names).toContain("boond_documents_delete");
    expect(names).toContain("boond_documents_upload_slot");
  });

  it("get is readOnly, create is not, delete is destructive", () => {
    registerDocumentTools(server);
    const byName = new Map(vi.mocked(server.registerTool).mock.calls.map((c) => [c[0], c[1]]));
    expect(byName.get("boond_documents_get")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("boond_documents_create")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("boond_documents_delete")?.annotations?.destructiveHint).toBe(true);
  });

  describe("boond_documents_get handler", () => {
    it("returns binary documents as an embedded base64 resource in raw mode", async () => {
      vi.mocked(apiDownload).mockResolvedValue({
        data: Buffer.from("%PDF-1.4 fake"),
        contentType: "application/pdf",
        filename: "cv-dupont.pdf",
      });
      registerDocumentTools(server);
      const result = await handlerOf(server, "boond_documents_get")({ id: "123", mode: "raw" });
      expect(apiDownload).toHaveBeenCalledWith("/documents/123", expect.any(Function), {
        maxBytes: MAX_DOCUMENT_BYTES,
      });
      expect(result.content[0].text).toContain("cv-dupont.pdf");
      const resource = result.content[1].resource!;
      expect(resource.uri).toBe("boond://documents/123");
      expect(resource.mimeType).toBe("application/pdf");
      expect(Buffer.from(resource.blob!, "base64").toString()).toBe("%PDF-1.4 fake");
    });

    // Entity relations expose suffixed document ids (`123_resume`); rejecting
    // them pushed the caller into stripping the suffix, which silently returns
    // the app shell instead of the file — see issue #186.
    it("accepts the suffixed ids exposed by entity relations", async () => {
      vi.mocked(apiDownload).mockResolvedValue({
        data: Buffer.from("%PDF-1.4 fake"),
        contentType: "application/pdf",
        filename: "cv-dupont.pdf",
      });
      registerDocumentTools(server);
      const config = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === "boond_documents_get")![1];
      const schema = config.inputSchema as unknown as {
        shape: { id: { safeParse: (v: unknown) => { success: boolean } } };
      };
      expect(schema.shape.id.safeParse("123_resume").success).toBe(true);
      expect(schema.shape.id.safeParse("../invoices/5").success).toBe(false);

      const result = await handlerOf(server, "boond_documents_get")({ id: "123_resume", mode: "raw" });
      expect(apiDownload).toHaveBeenCalledWith("/documents/123_resume", expect.any(Function), {
        maxBytes: MAX_DOCUMENT_BYTES,
      });
      expect(result.content[1].resource!.uri).toBe("boond://documents/123_resume");
    });

    // Issue #263 — the default mode makes a document readable instead of a blob.
    it("returns images as MCP image content (the shape hosts pass to the model's vision input)", async () => {
      vi.mocked(apiDownload).mockResolvedValue({
        data: Buffer.from("png-bytes"),
        contentType: "image/png",
        filename: "ticket.png",
      });
      registerDocumentTools(server);
      const result = await handlerOf(server, "boond_documents_get")({ id: "7", mode: "text" });
      expect(result.content[1]).toEqual({
        type: "image",
        data: Buffer.from("png-bytes").toString("base64"),
        mimeType: "image/png",
      });
      expect(result.content[0].text).toContain("ticket.png");
    });

    it("falls back to an embedded resource with a note for an image over MAX_IMAGE_BYTES", async () => {
      vi.mocked(apiDownload).mockResolvedValue({
        data: Buffer.alloc(MAX_IMAGE_BYTES + 1, 1),
        contentType: "image/jpeg",
        filename: "poster.jpg",
      });
      registerDocumentTools(server);
      const result = await handlerOf(server, "boond_documents_get")({ id: "8", mode: "text" });
      expect(result.content[0].text).toContain("au-delà des 2 Mo");
      expect(result.content[1].type).toBe("resource");
    });

    it("extracts the text of a PDF, with size and page count, in the default mode", async () => {
      vi.mocked(apiDownload).mockResolvedValue({
        data: buildPdf("Jean Dupont Developpeur TypeScript"),
        contentType: "application/pdf",
        filename: "cv.pdf",
      });
      registerDocumentTools(server);
      const result = await handlerOf(server, "boond_documents_get")({ id: "9", mode: "text" });
      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toContain("1 page(s)) — texte extrait :");
      expect(result.content[0].text).toContain("Jean Dupont Developpeur TypeScript");
    });

    it("extracts the text of a DOCX through the native zip reader", async () => {
      const xml = `<w:document><w:body><w:p><w:r><w:t>Profil DOCX</w:t></w:r></w:p></w:body></w:document>`;
      vi.mocked(apiDownload).mockResolvedValue({
        data: buildZip([{ name: "word/document.xml", data: Buffer.from(xml), deflate: true }]),
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: "cv.docx",
      });
      registerDocumentTools(server);
      const result = await handlerOf(server, "boond_documents_get")({ id: "10", mode: "text" });
      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toContain("Profil DOCX");
    });

    it("extracts a .docx served as application/msword (BoondManager's mime for resumes, #311)", async () => {
      const xml = `<w:document><w:body><w:p><w:r><w:t>Profil msword</w:t></w:r></w:p></w:body></w:document>`;
      vi.mocked(apiDownload).mockResolvedValue({
        data: buildZip([{ name: "word/document.xml", data: Buffer.from(xml) }]),
        contentType: "application/msword",
        filename: "CV_Silamir_AA.docx",
      });
      registerDocumentTools(server);
      const result = await handlerOf(server, "boond_documents_get")({ id: "13", mode: "text" });
      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toContain("Profil msword");
    });

    it("returns the raw file with a warning when nothing can be extracted (scan, encrypted, malformed)", async () => {
      vi.mocked(apiDownload).mockResolvedValue({
        data: Buffer.from("%PDF-1.4 fake"),
        contentType: "application/pdf",
        filename: "scan.pdf",
      });
      registerDocumentTools(server);
      const result = await handlerOf(server, "boond_documents_get")({ id: "11", mode: "text" });
      expect(result.content[0].text).toContain("Extraction du texte impossible");
      expect(result.content[1].type).toBe("resource");
    });

    it("truncates a long extracted text at CHARACTER_LIMIT and says how to get the whole file", async () => {
      const xml = `<w:document><w:body><w:p><w:r><w:t>${"x".repeat(CHARACTER_LIMIT + 500)}</w:t></w:r></w:p></w:body></w:document>`;
      vi.mocked(apiDownload).mockResolvedValue({
        data: buildZip([{ name: "word/document.xml", data: Buffer.from(xml) }]),
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: "long.docx",
      });
      registerDocumentTools(server);
      const result = await handlerOf(server, "boond_documents_get")({ id: "12", mode: "text" });
      expect(result.content[0].text).toContain(`[Texte tronqué à ${CHARACTER_LIMIT} caractères`);
      expect(result.content[0].text.length).toBeLessThan(CHARACTER_LIMIT + 400);
    });

    it("defaults mode to text in the advertised schema", () => {
      registerDocumentTools(server);
      const config = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === "boond_documents_get")![1];
      const schema = config.inputSchema as unknown as { parse: (v: unknown) => { mode: string } };
      expect(schema.parse({ id: "1" }).mode).toBe("text");
    });

    it("mentions the suffix in its description so the id isn't truncated", () => {
      registerDocumentTools(server);
      const config = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === "boond_documents_get")![1];
      expect(config.description).toContain("123_resume");
    });

    it("returns text documents as plain text", async () => {
      vi.mocked(apiDownload).mockResolvedValue({
        data: Buffer.from("Jean Dupont — Développeur TypeScript"),
        contentType: "text/plain",
        filename: "cv.txt",
      });
      registerDocumentTools(server);
      const result = await handlerOf(server, "boond_documents_get")({ id: "5" });
      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toContain("Développeur TypeScript");
    });

    // The cap is enforced by `apiDownload` while the bytes arrive (#235); the
    // tool's job is to hand it the ceiling and turn the refusal into a tool
    // error the model can act on, with the size when the API announced it.
    it("refuses documents over the size cap without buffering them (announced size)", async () => {
      vi.mocked(apiDownload).mockRejectedValue(
        new DownloadTooLargeError("/documents/9", 6 * 1024 * 1024, MAX_DOCUMENT_BYTES, true)
      );
      registerDocumentTools(server);
      const result = await handlerOf(server, "boond_documents_get")({ id: "9" });
      expect(apiDownload).toHaveBeenCalledWith("/documents/9", expect.any(Function), { maxBytes: MAX_DOCUMENT_BYTES });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("trop volumineux");
      expect(result.content[0].text).toContain("6.0 Mo (max 5 Mo)");
    });

    it("says 'plus de' when the download was cut mid-stream (no Content-Length)", async () => {
      vi.mocked(apiDownload).mockRejectedValue(
        new DownloadTooLargeError("/documents/9", MAX_DOCUMENT_BYTES + 1, MAX_DOCUMENT_BYTES, false)
      );
      registerDocumentTools(server);
      const result = await handlerOf(server, "boond_documents_get")({ id: "9" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("plus de 5.0 Mo (max 5 Mo)");
    });

    it("lets any other download error propagate", async () => {
      vi.mocked(apiDownload).mockRejectedValue(new Error("BoondManager API error 404"));
      registerDocumentTools(server);
      await expect(handlerOf(server, "boond_documents_get")({ id: "9" })).rejects.toThrow("404");
    });
  });

  describe("boond_documents_create parentType", () => {
    const parse = (parentType: unknown) =>
      DocumentCreateSchema.safeParse({ parentType, parentId: 462, fileUrl: "https://example.com/offre.pdf" });

    it("accepts every known parent type, besoins (opportunity) and positionnements included", () => {
      expect(DocumentParentTypes).toContain("opportunity");
      expect(DocumentParentTypes).toContain("positioning");
      for (const type of DocumentParentTypes) expect(parse(type).success, type).toBe(true);
    });

    it("accepts a well-formed type that is not in the known list (the API stays the authority)", () => {
      expect(parse("someFutureEntity").success).toBe(true);
    });

    it.each(["", " ", "opportunity ", "a b", "../project", "project/1", "1project", "x".repeat(65), "a=b&c", 42, null])(
      "rejects a malformed parentType: %j",
      (bad) => {
        expect(parse(bad).success).toBe(false);
      }
    );

    it("lists the besoin / positioning types in the tool description", () => {
      registerDocumentTools(server);
      const call = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === "boond_documents_create");
      const config = call?.[1] as { description: string };
      expect(config.description).toContain("parentType=opportunity");
      expect(config.description).toContain("positioning");
    });
  });

  describe("boond_documents_create handler", () => {
    it("uploads via multipart form fields and returns the created id", async () => {
      vi.mocked(apiUploadForm).mockResolvedValue({
        data: { id: "777", type: "document", attributes: {} },
      });
      registerDocumentTools(server);
      const result = await handlerOf(
        server,
        "boond_documents_create"
      )({
        parentType: "candidateResume",
        parentId: 42,
        fileUrl: "https://example.com/cv.pdf",
        parsing: true,
      });
      expect(apiUploadForm).toHaveBeenCalledWith("/documents", {
        parentType: "candidateResume",
        parentId: "42",
        fileUrl: "https://example.com/cv.pdf",
        parsing: "true",
      });
      expect(result.structuredContent).toEqual({ id: "777", type: "document" });
      expect(result.content[0].text).toContain("777");
    });

    it("forwards an opportunity (besoin) parent to the API unchanged, via a relay slot", async () => {
      const relayed = {
        downloadUrl: "https://relay.example/dl",
        filename: "offre.pdf",
        contentType: "application/pdf",
        size: 113 * 1024,
        release: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(uploadRelay.claim).mockResolvedValue(relayed as never);
      vi.mocked(apiUploadForm).mockResolvedValue({ data: { id: "900", type: "document", attributes: {} } });
      registerDocumentTools(server);
      const slot = "21d7c7f5-bc3a-4a08-859d-8eebbc0e98c2";
      const result = await handlerOf(
        server,
        "boond_documents_create"
      )({ parentType: "opportunity", parentId: 462, uploadSlot: slot });
      expect(apiUploadForm).toHaveBeenCalledWith("/documents", {
        parentType: "opportunity",
        parentId: "462",
        fileUrl: "https://relay.example/dl",
      });
      expect(relayed.release).toHaveBeenCalledTimes(1);
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({ id: "900", type: "document" });
    });

    it("uploads a local file as a binary multipart part, without fileUrl", async () => {
      const file = { data: Buffer.from("%PDF-1.7"), filename: "cv.pdf", contentType: "application/pdf" };
      vi.mocked(readLocalUpload).mockResolvedValue(file);
      vi.mocked(apiUploadForm).mockResolvedValue({ data: { id: "778", type: "document", attributes: {} } });
      registerDocumentTools(server);
      const result = await handlerOf(
        server,
        "boond_documents_create"
      )({
        parentType: "expensesReport",
        parentId: 9,
        filePath: "/home/me/Boond/ticket.pdf",
      });
      expect(readLocalUpload).toHaveBeenCalledWith("/home/me/Boond/ticket.pdf");
      expect(apiUploadForm).toHaveBeenCalledWith("/documents", { parentType: "expensesReport", parentId: "9" }, file);
      expect(result.structuredContent).toEqual({ id: "778", type: "document" });
      expect(result.content[0].text).toContain("cv.pdf");
    });

    it("surfaces a policy refusal as a tool error and never calls the API", async () => {
      vi.mocked(readLocalUpload).mockRejectedValue(
        new UploadRejectedError("Téléversement de fichiers locaux désactivé.")
      );
      registerDocumentTools(server);
      const result = await handlerOf(
        server,
        "boond_documents_create"
      )({
        parentType: "candidateResume",
        parentId: 1,
        filePath: "/etc/passwd",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("désactivé");
      expect(apiUploadForm).not.toHaveBeenCalled();
    });

    it("uploads inline base64 content with its file name", async () => {
      vi.mocked(apiUploadForm).mockResolvedValue({ data: { id: "779", type: "document", attributes: {} } });
      registerDocumentTools(server);
      await handlerOf(
        server,
        "boond_documents_create"
      )({
        parentType: "candidateResume",
        parentId: 42,
        fileContent: Buffer.from("%PDF-1.7 cv").toString("base64"),
        fileName: "cv.pdf",
        parsing: true,
      });
      expect(apiUploadForm).toHaveBeenCalledWith(
        "/documents",
        { parentType: "candidateResume", parentId: "42", parsing: "true" },
        { data: Buffer.from("%PDF-1.7 cv"), filename: "cv.pdf", contentType: "application/pdf" }
      );
    });

    it("sends a relayed upload to Boond by its download URL, then purges it — even when Boond fails", async () => {
      const release = vi.fn().mockResolvedValue(undefined);
      vi.mocked(uploadRelay.claim).mockResolvedValue({
        downloadUrl: "https://t.sharepoint.com/_layouts/15/download.aspx?tempauth=x",
        filename: "cv.pdf",
        contentType: "application/pdf",
        size: 42_000,
        release,
      });
      vi.mocked(apiUploadForm).mockResolvedValue({ data: { id: "780", type: "document", attributes: {} } });
      registerDocumentTools(server);
      const create = handlerOf(server, "boond_documents_create");
      const slot = "3f1c8a52-6b9e-4d7a-9a41-2c5e8f0b7d13";
      const result = await create({ parentType: "candidateResume", parentId: 42, uploadSlot: slot, parsing: true });
      expect(uploadRelay.claim).toHaveBeenCalledWith(slot);
      expect(apiUploadForm).toHaveBeenCalledWith("/documents", {
        parentType: "candidateResume",
        parentId: "42",
        fileUrl: "https://t.sharepoint.com/_layouts/15/download.aspx?tempauth=x",
        parsing: "true",
      });
      expect(release).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain("copie de transit supprimée");

      vi.mocked(apiUploadForm).mockRejectedValueOnce(new Error("Boond 500"));
      await expect(create({ parentType: "candidateResume", parentId: 42, uploadSlot: slot })).rejects.toThrow(
        "Boond 500"
      );
      expect(release).toHaveBeenCalledTimes(2);
    });

    it("surfaces a relay refusal (unknown slot, nothing uploaded) as a tool error", async () => {
      vi.mocked(uploadRelay.claim).mockRejectedValue(new UploadRejectedError("`uploadSlot` inconnu ou déjà utilisé"));
      registerDocumentTools(server);
      const result = await handlerOf(
        server,
        "boond_documents_create"
      )({
        parentType: "company",
        parentId: 1,
        uploadSlot: "3f1c8a52-6b9e-4d7a-9a41-2c5e8f0b7d13",
      });
      expect(result.isError).toBe(true);
      expect(apiUploadForm).not.toHaveBeenCalled();
    });

    it("requires exactly one source, and fileName only with fileContent", async () => {
      registerDocumentTools(server);
      const create = handlerOf(server, "boond_documents_create");
      const none = await create({ parentType: "company", parentId: 1 });
      expect(none.isError).toBe(true);
      expect(none.content[0].text).toContain("reçu : 0");
      const two = await create({ parentType: "company", parentId: 1, fileUrl: "https://x/y.pdf", filePath: "/a.pdf" });
      expect(two.content[0].text).toContain("reçu : 2");
      const noName = await create({ parentType: "company", parentId: 1, fileContent: "JVBERi0=" });
      expect(noName.content[0].text).toContain("`fileName`");
      const strayName = await create({
        parentType: "company",
        parentId: 1,
        fileUrl: "https://x/y.pdf",
        fileName: "y.pdf",
      });
      expect(strayName.isError).toBe(true);
      expect(apiUploadForm).not.toHaveBeenCalled();
    });
  });

  describe("boond_documents_upload_slot", () => {
    it("returns the slot and a ready-to-run single-PUT curl command", async () => {
      vi.mocked(uploadRelay.open).mockResolvedValue({
        uploadSlot: "3f1c8a52-6b9e-4d7a-9a41-2c5e8f0b7d13",
        uploadUrl: "https://t.sharepoint.com/upload?tempauth=y",
        expiresAt: "2026-09-29T10:15:00.000Z",
        maxBytes: 20 * 1024 * 1024,
        filename: "cv.pdf",
      });
      registerDocumentTools(server);
      const result = await handlerOf(server, "boond_documents_upload_slot")({ fileName: "cv.pdf" });
      expect(uploadRelay.open).toHaveBeenCalledWith("cv.pdf");
      expect(result.structuredContent).toMatchObject({
        uploadSlot: "3f1c8a52-6b9e-4d7a-9a41-2c5e8f0b7d13",
        uploadUrl: "https://t.sharepoint.com/upload?tempauth=y",
        fileName: "cv.pdf",
      });
      const command = (result.structuredContent as { uploadCommand: string }).uploadCommand;
      expect(command).toContain("-X PUT");
      expect(command).toContain("Content-Range: bytes 0-$((N-1))/$N");
      expect(command).toContain('"https://t.sharepoint.com/upload?tempauth=y"');
    });

    it("reports a disabled relay as a tool error", async () => {
      vi.mocked(uploadRelay.open).mockRejectedValue(new UploadRejectedError("Relais d'upload désactivé"));
      registerDocumentTools(server);
      const result = await handlerOf(server, "boond_documents_upload_slot")({ fileName: "cv.pdf" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("désactivé");
    });
  });
});
