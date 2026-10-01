import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeInlineUpload, readLocalUpload, sniffDocumentType, UploadRejectedError } from "./upload-source.js";
import { INLINE_UPLOAD_MAX_BYTES } from "../constants.js";

const PDF = Buffer.from("%PDF-1.7\n%fake\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]);

describe("sniffDocumentType", () => {
  it("recognises formats by their leading bytes", () => {
    expect(sniffDocumentType(PDF, "cv.pdf")?.contentType).toBe("application/pdf");
    expect(sniffDocumentType(PNG, "ticket.png")?.contentType).toBe("image/png");
    expect(sniffDocumentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "a.jpg")?.contentType).toBe("image/jpeg");
    expect(sniffDocumentType(Buffer.from("{\\rtf1 hello"), "a.rtf")?.contentType).toBe("application/rtf");
  });

  it("uses the extension only to pick a member of a ZIP or OLE container", () => {
    expect(sniffDocumentType(ZIP, "cv.docx")?.contentType).toContain("wordprocessingml");
    expect(sniffDocumentType(ZIP, "budget.xlsx")?.contentType).toContain("spreadsheetml");
    expect(sniffDocumentType(OLE, "old.doc")?.contentType).toBe("application/msword");
    // A ZIP that claims to be a PDF, or an arbitrary archive, is not a document.
    expect(sniffDocumentType(ZIP, "cv.pdf")).toBeUndefined();
    expect(sniffDocumentType(ZIP, "payload.zip")).toBeUndefined();
  });

  it("refuses unknown content whatever its name", () => {
    expect(sniffDocumentType(Buffer.from("#!/bin/sh\nrm -rf /"), "cv.pdf")).toBeUndefined();
    expect(sniffDocumentType(Buffer.from("MZ\x90\x00"), "setup.exe")).toBeUndefined();
  });
});

describe("decodeInlineUpload", () => {
  it("decodes base64, with or without a data: URI prefix", () => {
    const plain = decodeInlineUpload(PDF.toString("base64"), "cv.pdf");
    expect(plain).toEqual({ data: PDF, filename: "cv.pdf", contentType: "application/pdf" });
    const uri = decodeInlineUpload(`data:application/pdf;base64,${PDF.toString("base64")}`, "cv.pdf");
    expect(uri.data).toEqual(PDF);
  });

  it("keeps only the base name of fileName", () => {
    expect(decodeInlineUpload(PDF.toString("base64"), "../../etc/cv.pdf").filename).toBe("cv.pdf");
    expect(decodeInlineUpload(PDF.toString("base64"), "C:\\Users\\x\\cv.pdf").filename).toBe("cv.pdf");
  });

  it("rejects invalid base64, oversized content and mismatched extensions", () => {
    expect(() => decodeInlineUpload("not base64!!", "cv.pdf")).toThrow(UploadRejectedError);
    const big = Buffer.concat([PDF, Buffer.alloc(INLINE_UPLOAD_MAX_BYTES)]).toString("base64");
    expect(() => decodeInlineUpload(big, "cv.pdf")).toThrow(/trop volumineux/);
    expect(() => decodeInlineUpload(PDF.toString("base64"), "cv.docx")).toThrow(/Extension incohérente/);
    expect(() => decodeInlineUpload(PDF.toString("base64"), "..")).toThrow(/fileName/);
  });
});

describe("readLocalUpload", () => {
  let root: string;
  let allowed: string;
  let outside: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "boond-upload-"));
    allowed = join(root, "allowed");
    outside = join(root, "outside");
    await mkdir(allowed);
    await mkdir(outside);
    await writeFile(join(allowed, "cv.pdf"), PDF);
    await writeFile(join(allowed, "fake.pdf"), "#!/bin/sh\n");
    await writeFile(join(outside, "secret.pdf"), PDF);
    await symlink(join(outside, "secret.pdf"), join(allowed, "link.pdf"));
    await mkdir(join(allowed, "sub.pdf"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const env = (extra: Record<string, string> = {}) => ({ BOOND_MCP_UPLOAD_DIRS: allowed, ...extra });

  it("reads an allowed file and sniffs its type", async () => {
    const file = await readLocalUpload(join(allowed, "cv.pdf"), env());
    expect(file).toEqual({ data: PDF, filename: "cv.pdf", contentType: "application/pdf" });
  });

  it("is disabled until BOOND_MCP_UPLOAD_DIRS is set — blank counts as unset", async () => {
    await expect(readLocalUpload(join(allowed, "cv.pdf"), {})).rejects.toThrow(/BOOND_MCP_UPLOAD_DIRS/);
    await expect(readLocalUpload(join(allowed, "cv.pdf"), { BOOND_MCP_UPLOAD_DIRS: "  " })).rejects.toThrow(
      /désactivé/
    );
  });

  it("is refused over the HTTP transport even when directories are allowed", async () => {
    await expect(readLocalUpload(join(allowed, "cv.pdf"), env({ MCP_TRANSPORT: "http" }))).rejects.toThrow(
      /transport HTTP/
    );
  });

  it("refuses paths outside the allowed directories, including via .. and symlinks", async () => {
    await expect(readLocalUpload(join(outside, "secret.pdf"), env())).rejects.toThrow(/hors des répertoires/);
    await expect(readLocalUpload(join(allowed, "..", "outside", "secret.pdf"), env())).rejects.toThrow(
      /hors des répertoires/
    );
    await expect(readLocalUpload(join(allowed, "link.pdf"), env())).rejects.toThrow(/hors des répertoires/);
    // A sibling whose name merely starts with the allowed directory's name.
    await expect(readLocalUpload(`${allowed}-evil/cv.pdf`, env())).rejects.toThrow(/introuvable/);
  });

  it("refuses relative paths, missing files, directories, oversize files and non-documents", async () => {
    await expect(readLocalUpload("cv.pdf", env())).rejects.toThrow(/chemin absolu/);
    await expect(readLocalUpload(join(allowed, "nope.pdf"), env())).rejects.toThrow(/introuvable/);
    await expect(readLocalUpload(join(allowed, "sub.pdf"), env())).rejects.toThrow(/n'est pas un fichier/);
    await expect(readLocalUpload(join(allowed, "cv.pdf"), env({ BOOND_MCP_UPLOAD_MAX_BYTES: "4" }))).rejects.toThrow(
      /trop volumineux/
    );
    await expect(readLocalUpload(join(allowed, "fake.pdf"), env())).rejects.toThrow(/Format non accepté/);
  });

  it("accepts several comma-separated directories and ignores relative or missing entries", async () => {
    const file = await readLocalUpload(join(allowed, "cv.pdf"), {
      BOOND_MCP_UPLOAD_DIRS: `relative/dir, ${join(root, "missing")}, ${allowed}`,
    });
    expect(file.filename).toBe("cv.pdf");
  });
});
