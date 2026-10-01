/**
 * File sources for `boond_documents_create` beyond `fileUrl`.
 *
 * Until this module, the only way to attach a document was a public https URL
 * that BoondManager downloads itself, and the server never read a byte of file
 * content. That posture stays the default: both sources below are bounded, and
 * the one that touches the disk is **off unless the operator opts in**.
 *
 * - `filePath` (stdio only, opt-in): the server reads a local file, but only
 *   under a directory listed in `BOOND_MCP_UPLOAD_DIRS`. The check runs on the
 *   `realpath` of both sides, so `..` segments and symlinks pointing outside an
 *   allowed directory are refused. Over HTTP the server does not run on the
 *   user's machine, so a path would name a file on the *server* host — refused.
 * - `fileContent` (base64, every transport, always on): no disk access at all,
 *   capped at {@link INLINE_UPLOAD_MAX_BYTES} because every byte is paid ~1.33×
 *   in the model's output tokens.
 *
 * Both sources are sniffed by magic bytes, not by extension, and must match a
 * short allow-list of document formats: the declared name decides nothing.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, sep } from "node:path";
import { readCsv, readPositiveInt } from "../config/env.js";
import { resolveTransport } from "../config/transport-kind.js";
import { DEFAULT_UPLOAD_MAX_BYTES, INLINE_UPLOAD_MAX_BYTES } from "../constants.js";

export interface UploadFile {
  data: Buffer;
  filename: string;
  contentType: string;
}

/** A refusal whose message is meant for the caller, not a crash. */
export class UploadRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadRejectedError";
  }
}

interface SniffedType {
  contentType: string;
  /** Extensions a file of this family may carry (lower case, with dot). */
  extensions: readonly string[];
}

const OOXML: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
};

const LEGACY_OFFICE: Record<string, string> = {
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
};

function startsWith(data: Buffer, bytes: readonly number[], offset = 0): boolean {
  if (data.length < offset + bytes.length) return false;
  return bytes.every((b, i) => data[offset + i] === b);
}

/**
 * The document type of `data`, from its leading bytes. ZIP and OLE containers
 * are ambiguous by content alone (a .docx and a .xlsx share a signature), so
 * for those two families the extension picks the member — but only among
 * formats of that container: a ZIP named `.pdf` is still refused.
 */
export function sniffDocumentType(data: Buffer, filename: string): SniffedType | undefined {
  const ext = extname(filename).toLowerCase();
  if (startsWith(data, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { contentType: "application/pdf", extensions: [".pdf"] };
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { contentType: "image/png", extensions: [".png"] };
  if (startsWith(data, [0xff, 0xd8, 0xff])) return { contentType: "image/jpeg", extensions: [".jpg", ".jpeg"] };
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38])) return { contentType: "image/gif", extensions: [".gif"] };
  if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8))
    return { contentType: "image/webp", extensions: [".webp"] };
  if (startsWith(data, [0x7b, 0x5c, 0x72, 0x74, 0x66])) return { contentType: "application/rtf", extensions: [".rtf"] };
  if (startsWith(data, [0x50, 0x4b, 0x03, 0x04])) {
    const contentType = OOXML[ext];
    return contentType ? { contentType, extensions: [ext] } : undefined;
  }
  if (startsWith(data, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    const contentType = LEGACY_OFFICE[ext];
    return contentType ? { contentType, extensions: [ext] } : undefined;
  }
  return undefined;
}

const ACCEPTED_FORMATS = "PDF, DOCX/XLSX/PPTX, ODT/ODS, DOC/XLS/PPT, RTF, PNG, JPEG, GIF, WebP";

function typeOrReject(data: Buffer, filename: string): string {
  const sniffed = sniffDocumentType(data, filename);
  if (!sniffed) {
    throw new UploadRejectedError(
      `Format non accepté pour « ${filename} » : le contenu ne correspond à aucun format autorisé (${ACCEPTED_FORMATS}). ` +
        "Le type est déterminé par les premiers octets du fichier, pas par son extension."
    );
  }
  if (!sniffed.extensions.includes(extname(filename).toLowerCase())) {
    throw new UploadRejectedError(
      `Extension incohérente pour « ${filename} » : le contenu est de type ${sniffed.contentType} ` +
        `(extension attendue : ${sniffed.extensions.join(" ou ")}).`
    );
  }
  return sniffed.contentType;
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

/** The allowed upload directories, resolved to real paths. Missing ones are skipped. */
async function allowedDirs(env: NodeJS.ProcessEnv): Promise<string[] | undefined> {
  const raw = readCsv("BOOND_MCP_UPLOAD_DIRS", env);
  if (!raw) return undefined;
  const resolved: string[] = [];
  for (const dir of raw) {
    if (!isAbsolute(dir)) continue;
    try {
      resolved.push(await realpath(dir));
    } catch {
      // A listed directory that does not exist allows nothing; not fatal.
    }
  }
  return resolved;
}

function isInside(file: string, dir: string): boolean {
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  return file.startsWith(prefix);
}

/**
 * Read a local file for upload, enforcing the operator's policy: stdio
 * transport, an allowed directory (after symlink resolution), a regular file,
 * the size ceiling, and an accepted document format.
 */
export async function readLocalUpload(filePath: string, env: NodeJS.ProcessEnv = process.env): Promise<UploadFile> {
  if (resolveTransport(env) === "http") {
    throw new UploadRejectedError(
      "`filePath` est indisponible en transport HTTP : le serveur ne tourne pas sur le poste de l'utilisateur. " +
        "Utiliser `fileUrl`, ou `fileContent` (base64) pour un petit fichier."
    );
  }
  const dirs = await allowedDirs(env);
  if (dirs === undefined) {
    throw new UploadRejectedError(
      "Téléversement de fichiers locaux désactivé. L'opérateur du serveur doit définir `BOOND_MCP_UPLOAD_DIRS` " +
        "(répertoires autorisés, chemins absolus). En attendant : `fileUrl`, ou `fileContent` (base64) pour un petit fichier."
    );
  }
  if (!isAbsolute(filePath)) {
    throw new UploadRejectedError(`\`filePath\` doit être un chemin absolu (reçu : « ${filePath} »).`);
  }
  let real: string;
  try {
    real = await realpath(filePath);
  } catch {
    throw new UploadRejectedError(`Fichier introuvable : « ${filePath} ».`);
  }
  if (!dirs.some((dir) => isInside(real, dir))) {
    throw new UploadRejectedError(
      `« ${filePath} » est hors des répertoires autorisés par \`BOOND_MCP_UPLOAD_DIRS\` (liens symboliques résolus).`
    );
  }
  const info = await stat(real);
  if (!info.isFile()) throw new UploadRejectedError(`« ${filePath} » n'est pas un fichier.`);
  const maxBytes = readPositiveInt("BOOND_MCP_UPLOAD_MAX_BYTES", DEFAULT_UPLOAD_MAX_BYTES, env);
  if (info.size > maxBytes) {
    throw new UploadRejectedError(
      `Fichier trop volumineux : ${mb(info.size)} Mo (max ${mb(maxBytes)} Mo, \`BOOND_MCP_UPLOAD_MAX_BYTES\`).`
    );
  }
  const data = await readFile(real);
  // The file may have grown between stat() and readFile().
  if (data.length > maxBytes) {
    throw new UploadRejectedError(`Fichier trop volumineux : ${mb(data.length)} Mo (max ${mb(maxBytes)} Mo).`);
  }
  const filename = basename(real);
  return { data, filename, contentType: typeOrReject(data, filename) };
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decode base64 content passed inline, with an optional `data:` URI prefix. */
export function decodeInlineUpload(fileContent: string, fileName: string): UploadFile {
  const filename = basename(fileName.replace(/\\/g, "/")).trim();
  if (filename.length === 0 || filename === "." || filename === "..") {
    throw new UploadRejectedError("`fileName` doit être un nom de fichier avec son extension (ex. « cv.pdf »).");
  }
  const payload = fileContent.replace(/^data:[^;,]*;base64,/, "").replace(/\s+/g, "");
  if (payload.length === 0 || payload.length % 4 !== 0 || !BASE64.test(payload)) {
    throw new UploadRejectedError("`fileContent` n'est pas du base64 valide.");
  }
  const decodedLength = (payload.length / 4) * 3 - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0);
  if (decodedLength > INLINE_UPLOAD_MAX_BYTES) {
    throw new UploadRejectedError(
      `Contenu inline trop volumineux : ${mb(decodedLength)} Mo (max ${mb(INLINE_UPLOAD_MAX_BYTES)} Mo). ` +
        "Pour un fichier plus gros : `filePath` (serveur local) ou `fileUrl`."
    );
  }
  const data = Buffer.from(payload, "base64");
  return { data, filename, contentType: typeOrReject(data, filename) };
}
