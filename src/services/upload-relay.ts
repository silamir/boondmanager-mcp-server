/**
 * Upload relay for files that live neither at a public URL nor on the
 * server's host — typically a conversation attachment, which sits in the MCP
 * client's code-execution sandbox. The model cannot re-emit those bytes
 * reliably (see `fileContent`), so they must travel outside its output:
 *
 *   1. `boond_documents_upload_slot` asks the relay for a single-use,
 *      pre-authenticated upload URL on an object store the operator controls;
 *   2. the client's sandbox PUTs the file there (`curl`), bytes never passing
 *      through the model;
 *   3. `boond_documents_create({ uploadSlot })` checks the stored file (size,
 *      magic bytes), hands BoondManager a short-lived pre-authenticated
 *      download URL through the existing `fileUrl` mechanism, then purges the
 *      file — permanently, bypassing the recycle bin when the store allows.
 *
 * Store credentials stay on the server; the client only ever sees URLs scoped
 * to one file and one slot. Off unless `BOOND_MCP_UPLOAD_RELAY` is set.
 *
 * Backends implement {@link RelayBackend}: `sharepoint` (Microsoft Graph,
 * app-only `Sites.Selected`) and `gdrive` (Google Drive, service account, a
 * shared drive). Drive has no pre-authenticated download URL, so for it the
 * server reads the file itself and sends the bytes to BoondManager as a
 * multipart upload instead of a `fileUrl`.
 */
import { createSign, randomUUID } from "node:crypto";
import { extname } from "node:path";
import { readPositiveInt, readString } from "../config/env.js";
import { DEFAULT_UPLOAD_MAX_BYTES } from "../constants.js";
import { logger } from "./logger.js";
import { sniffDocumentType, UploadRejectedError } from "./upload-source.js";

/** How long a slot stays usable after creation. */
export const SLOT_TTL_MS = 15 * 60 * 1000;
const GRAPH = "https://graph.microsoft.com/v1.0";
const REQUEST_TIMEOUT_MS = 30_000;

export interface SlotHandle {
  /** Backend-private reference to the stored object (e.g. Graph folder id). */
  ref: string;
  /** Pre-authenticated URL the client PUTs the file to (single request). */
  uploadUrl: string;
  expiresAt: Date;
}

export interface StoredObject {
  size: number;
  /**
   * Short-lived, pre-authenticated URL BoondManager can download. Absent when
   * the store has none (Google Drive): the backend then implements `read`.
   */
  downloadUrl?: string;
  /** Backend-private id of the stored file, for `head` / `read`. */
  fileId?: string;
}

/** `trashed`: the permanent delete was refused and the copy went to the store's trash. */
export type PurgeOutcome = "deleted" | "trashed";

export interface RelayBackend {
  readonly name: string;
  createSlot(slotId: string, filename: string): Promise<SlotHandle>;
  /** `undefined` when nothing was uploaded to the slot yet. */
  stat(ref: string, filename: string): Promise<StoredObject | undefined>;
  /** First bytes of the stored object, for type sniffing. */
  head(stored: StoredObject, bytes: number): Promise<Buffer>;
  /** Whole content, for stores without a pre-authenticated URL. */
  read?(stored: StoredObject): Promise<Buffer>;
  /**
   * Delete the slot's stored copy. `stored`, when known, lets a backend delete
   * by id instead of searching: a search can lag behind a fresh upload.
   */
  purge(ref: string, stored?: StoredObject): Promise<PurgeOutcome | void>;
  /**
   * Delete whatever an expired or forgotten slot left in the store. Needed when
   * an upload can still land after the slot expired (Drive's resumable session
   * outlives the slot), or after a restart lost the in-memory registry.
   */
  sweepStale?(olderThan: Date): Promise<void>;
}

// ---------------------------------------------------------------------------
// SharePoint / Microsoft Graph backend
// ---------------------------------------------------------------------------

export interface SharePointConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** `host:/sites/path` (Graph site key). */
  site: string;
  library: string;
}

/** Accept `https://host/sites/x`, `host/sites/x` or `host:/sites/x`. */
export function normalizeSiteKey(raw: string): string {
  const s = raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  if (s.includes(":/")) return s;
  const slash = s.indexOf("/");
  return slash === -1 ? s : `${s.slice(0, slash)}:${s.slice(slash)}`;
}

/** SharePoint forbids `" * : < > ? / \ |` and `#`/`%` cause URL trouble. */
export function sanitizeSharePointName(filename: string): string {
  const cleaned = filename
    .replace(/["*:<>?/\\|#%]/g, "_")
    .split("")
    .filter((c) => c.charCodeAt(0) >= 0x20)
    .join("")
    .trim()
    .replace(/^\.+|\.+$/g, "");
  return (cleaned.length > 0 ? cleaned : "document").slice(0, 200);
}

export class SharePointRelay implements RelayBackend {
  readonly name = "sharepoint";
  private token?: { value: string; expiresAt: number };
  private driveId?: string;

  constructor(private readonly cfg: SharePointConfig) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      scope: "https://graph.microsoft.com/.default",
    });
    const res = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(this.cfg.tenantId)}/oauth2/v2.0/token`,
      { method: "POST", body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
    );
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!res.ok || !json.access_token) {
      // Never echo the request (it carries the secret); the error code is enough.
      throw new Error(`Relais SharePoint : authentification Entra ID refusée (${json.error ?? res.status}).`);
    }
    this.token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async graph<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
    const res = await fetch(`${GRAPH}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let json = {} as T;
    try {
      if (text) json = JSON.parse(text) as T;
    } catch {
      // Non-JSON error page (proxy, throttling HTML): the status says enough.
    }
    return { status: res.status, json };
  }

  private async graphOk<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, json } = await this.graph<T & { error?: { code?: string; message?: string } }>(method, path, body);
    if (status >= 400) {
      const e = (json as { error?: { code?: string; message?: string } }).error;
      throw new Error(
        `Relais SharePoint : ${method} ${path.split("?")[0]} → ${status} ${e?.code ?? ""} ${e?.message ?? ""}`.trim()
      );
    }
    return json;
  }

  private async drive(): Promise<string> {
    if (this.driveId) return this.driveId;
    const site = await this.graphOk<{ id: string }>("GET", `/sites/${this.cfg.site}?$select=id`);
    const drives = await this.graphOk<{ value: { id: string; name: string; webUrl?: string }[] }>(
      "GET",
      `/sites/${site.id}/drives?$select=id,name,webUrl`
    );
    const wanted = this.cfg.library.toLowerCase();
    const match = drives.value.find(
      (d) => d.name.toLowerCase() === wanted || (d.webUrl ?? "").toLowerCase().endsWith(`/${wanted}`)
    );
    if (!match) {
      const names = drives.value.map((d) => d.name).join(", ");
      throw new Error(
        `Relais SharePoint : bibliothèque « ${this.cfg.library} » introuvable sur le site (trouvées : ${names}).`
      );
    }
    this.driveId = match.id;
    return match.id;
  }

  async createSlot(slotId: string, filename: string): Promise<SlotHandle> {
    const driveId = await this.drive();
    // One folder per slot keeps the file's own name intact — BoondManager
    // names the document after the download's Content-Disposition.
    const folder = await this.graphOk<{ id: string }>("POST", `/drives/${driveId}/root/children`, {
      name: `mcp-${slotId}`,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    });
    const name = encodeURIComponent(sanitizeSharePointName(filename));
    const session = await this.graphOk<{ uploadUrl: string; expirationDateTime?: string }>(
      "POST",
      `/drives/${driveId}/items/${folder.id}:/${name}:/createUploadSession`,
      { item: { "@microsoft.graph.conflictBehavior": "fail" } }
    );
    const graphExpiry = session.expirationDateTime ? Date.parse(session.expirationDateTime) : Infinity;
    return {
      ref: folder.id,
      uploadUrl: session.uploadUrl,
      expiresAt: new Date(Math.min(Date.now() + SLOT_TTL_MS, graphExpiry)),
    };
  }

  async stat(ref: string, filename: string): Promise<StoredObject | undefined> {
    const driveId = await this.drive();
    // List the slot's own folder instead of addressing the file by name: the
    // folder is private to the slot, so whatever file it holds is the upload,
    // and a name normalised differently by SharePoint cannot cause a miss.
    // No $select: SharePoint does not reliably return the download-URL
    // annotation under $select with app-only tokens.
    const { status, json } = await this.graph<{
      value?: Array<{
        id: string;
        name?: string;
        size?: number;
        file?: unknown;
        "@microsoft.graph.downloadUrl"?: string;
      }>;
    }>("GET", `/drives/${driveId}/items/${ref}/children`);
    if (status === 404) {
      throw new UploadRejectedError(
        "Dossier de transit du slot introuvable (supprimé à la main ?). Créer un nouveau slot avec `boond_documents_upload_slot`."
      );
    }
    if (status >= 400) throw new Error(`Relais SharePoint : lecture du dossier de transit → ${status}.`);
    const files = (json.value ?? []).filter((item) => item.file !== undefined);
    if (files.length === 0) return undefined;
    const wanted = sanitizeSharePointName(filename).toLowerCase();
    const item = files.find((f) => (f.name ?? "").toLowerCase() === wanted) ?? files[0]!;
    if (item.size === undefined) return undefined;
    const downloadUrl = item["@microsoft.graph.downloadUrl"] ?? (await this.contentRedirect(driveId, item.id));
    if (!downloadUrl) {
      throw new Error(
        `Relais SharePoint : fichier déposé trouvé (${item.size} octets) mais Graph ne fournit pas d'URL de lecture temporaire.`
      );
    }
    return { size: item.size, downloadUrl };
  }

  /** `/content` answers 302 to the same pre-authenticated URL; read it without following. */
  private async contentRedirect(driveId: string, itemId: string): Promise<string | undefined> {
    const res = await fetch(`${GRAPH}/drives/${driveId}/items/${itemId}/content`, {
      headers: { Authorization: `Bearer ${await this.accessToken()}` },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => undefined);
    return res.status >= 300 && res.status < 400 ? (res.headers.get("location") ?? undefined) : undefined;
  }

  async head(stored: StoredObject, bytes: number): Promise<Buffer> {
    if (!stored.downloadUrl) throw new Error("Relais SharePoint : pas d'URL de lecture pour ce fichier.");
    const res = await fetch(stored.downloadUrl, {
      headers: { Range: `bytes=0-${bytes - 1}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Relais SharePoint : lecture de l'en-tête du fichier → ${res.status}.`);
    return Buffer.from(await res.arrayBuffer()).subarray(0, bytes);
  }

  async purge(ref: string): Promise<void> {
    const driveId = await this.drive();
    // permanentDelete skips the recycle bin (RGPD: CVs, payslips...). Fall
    // back to a regular delete if the tenant refuses it.
    const { status } = await this.graph("POST", `/drives/${driveId}/items/${ref}/permanentDelete`);
    if (status < 400 || status === 404) return;
    const del = await this.graph("DELETE", `/drives/${driveId}/items/${ref}`);
    if (del.status >= 400 && del.status !== 404) {
      throw new Error(`Relais SharePoint : suppression du dossier de transit → ${del.status}.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Google Drive backend (service account, shared drive)
// ---------------------------------------------------------------------------

const DRIVE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/**
 * Full Drive scope: `drive.file` only covers files the app created or the user
 * opened with a picker, not a transit folder created by a human. What the
 * service account can reach is bounded by its membership instead: it should be
 * a member of one dedicated shared drive and nothing else.
 */
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
/** `appProperties` key tying the uploaded file to its slot. */
const SLOT_PROPERTY = "boondMcpSlot";

export interface GoogleDriveConfig {
  clientEmail: string;
  privateKey: string;
  /** Transit folder, inside a shared drive. */
  folderId: string;
}

/** Parse a service-account JSON key; a French reason when it is unusable. */
export function parseServiceAccountKey(raw: string): { clientEmail: string; privateKey: string } | string {
  let json: { client_email?: unknown; private_key?: unknown };
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    return "Relais Google Drive : `BOOND_MCP_GDRIVE_SERVICE_ACCOUNT_KEY` n'est pas un JSON valide (contenu de la clé du compte de service attendu).";
  }
  if (typeof json.client_email !== "string" || typeof json.private_key !== "string") {
    return "Relais Google Drive : la clé du compte de service doit contenir `client_email` et `private_key`.";
  }
  return { clientEmail: json.client_email, privateKey: json.private_key };
}

const base64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** RS256-signed JWT assertion for the OAuth 2.0 JWT bearer grant (service accounts). */
export function serviceAccountAssertion(cfg: { clientEmail: string; privateKey: string }, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({ iss: cfg.clientEmail, scope: DRIVE_SCOPE, aud: GOOGLE_TOKEN_URL, iat, exp: iat + 3600 })
  );
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(cfg.privateKey);
  return `${header}.${claims}.${base64url(signature)}`;
}

interface DriveFile {
  id: string;
  name?: string;
  size?: string;
  driveId?: string;
}

export class GoogleDriveRelay implements RelayBackend {
  readonly name = "gdrive";
  private token?: { value: string; expiresAt: number };
  private driveId?: string;

  constructor(private readonly cfg: GoogleDriveConfig) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: serviceAccountAssertion(this.cfg),
    });
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!res.ok || !json.access_token) {
      // Never echo the assertion (it is signed with the private key).
      throw new Error(
        `Relais Google Drive : authentification du compte de service refusée (${json.error ?? res.status}).`
      );
    }
    this.token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async drive(
    method: string,
    url: string,
    init: { body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<Response> {
    return fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json; charset=UTF-8" }),
        ...init.headers,
      },
      body: init.body === undefined ? null : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  private async fail(what: string, res: Response): Promise<never> {
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`Relais Google Drive : ${what} → ${res.status} ${json.error?.message ?? ""}`.trim());
  }

  /** The shared drive holding the transit folder; refuses a folder in a My Drive. */
  private async sharedDrive(): Promise<string> {
    if (this.driveId) return this.driveId;
    const res = await this.drive(
      "GET",
      `${DRIVE}/files/${encodeURIComponent(this.cfg.folderId)}?fields=id,driveId,mimeType&supportsAllDrives=true`
    );
    if (res.status === 404) {
      throw new Error(
        "Relais Google Drive : dossier de transit introuvable. Vérifier `BOOND_MCP_GDRIVE_FOLDER_ID` et que le compte de service est membre du Drive partagé."
      );
    }
    if (!res.ok) await this.fail("lecture du dossier de transit", res);
    const folder = (await res.json()) as { driveId?: string; mimeType?: string };
    if (folder.mimeType !== "application/vnd.google-apps.folder") {
      throw new Error("Relais Google Drive : `BOOND_MCP_GDRIVE_FOLDER_ID` ne désigne pas un dossier.");
    }
    if (!folder.driveId) {
      throw new Error(
        "Relais Google Drive : le dossier de transit doit se trouver dans un Drive partagé (un compte de service n'a pas d'espace de stockage dans un « Mon Drive »)."
      );
    }
    this.driveId = folder.driveId;
    return folder.driveId;
  }

  async createSlot(slotId: string, filename: string): Promise<SlotHandle> {
    await this.sharedDrive();
    // Resumable session: the client PUTs the bytes to the session URI; the
    // file only exists once the upload completes. `appProperties` lets `stat`
    // find it without knowing its id.
    const res = await this.drive("POST", `${DRIVE_UPLOAD}/files?uploadType=resumable&supportsAllDrives=true`, {
      body: { name: filename, parents: [this.cfg.folderId], appProperties: { [SLOT_PROPERTY]: slotId } },
    });
    if (!res.ok) await this.fail("ouverture de la session d'upload", res);
    await res.body?.cancel().catch(() => undefined);
    const uploadUrl = res.headers.get("location");
    if (!uploadUrl) throw new Error("Relais Google Drive : la session d'upload n'a pas renvoyé d'URL de dépôt.");
    return { ref: slotId, uploadUrl, expiresAt: new Date(Date.now() + SLOT_TTL_MS) };
  }

  /** Files of the transit folder matching `filter` (a Drive query clause). */
  private async listTransit(filter: string): Promise<DriveFile[]> {
    const driveId = await this.sharedDrive();
    const folder = this.cfg.folderId.replace(/[^A-Za-z0-9_-]/g, "");
    const q = `'${folder}' in parents and ${filter} and trashed=false`;
    const params = new URLSearchParams({
      q,
      corpora: "drive",
      driveId,
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
      fields: "files(id,name,size)",
    });
    const res = await this.drive("GET", `${DRIVE}/files?${params.toString()}`);
    if (!res.ok) await this.fail("recherche du fichier déposé", res);
    return ((await res.json()) as { files?: DriveFile[] }).files ?? [];
  }

  private findSlotFiles(slotId: string): Promise<DriveFile[]> {
    return this.listTransit(
      `appProperties has { key='${SLOT_PROPERTY}' and value='${slotId.replace(/[^0-9a-f-]/gi, "")}' }`
    );
  }

  private async deleteFile(id: string): Promise<PurgeOutcome> {
    const res = await this.drive("DELETE", `${DRIVE}/files/${encodeURIComponent(id)}?supportsAllDrives=true`);
    if (res.ok) return "deleted";
    if (res.status === 404) {
      // Observed on a real Workspace: without the Manager role on the shared
      // drive itself, files.delete answers 404 for a file the account can list
      // and read. Only a file that is really gone counts as deleted.
      const still = await this.drive(
        "GET",
        `${DRIVE}/files/${encodeURIComponent(id)}?fields=id&supportsAllDrives=true`
      );
      await still.body?.cancel().catch(() => undefined);
      if (still.status === 404) return "deleted";
    }
    // Permanent delete refused (403, or a 404 on a file still there): the
    // account lacks the Manager role on the shared drive. Fall back to the
    // trash (emptied by Drive after 30 days) rather than leave the file in the
    // transit folder, log it and report it to the caller. Not exercised on a
    // real Workspace (the role was granted before a refusal could occur).
    await res.body?.cancel().catch(() => undefined);
    const trash = await this.drive("PATCH", `${DRIVE}/files/${encodeURIComponent(id)}?supportsAllDrives=true`, {
      body: { trashed: true },
    });
    if (trash.ok) {
      await trash.body?.cancel().catch(() => undefined);
      logger.warn(
        { status: res.status },
        "upload relay: permanent delete refused, transit copy moved to the Drive trash (30 days); " +
          "give the service account the Manager role on the shared drive itself"
      );
      return "trashed";
    }
    throw new Error(
      `Relais Google Drive : suppression définitive refusée (${res.status}) et mise à la corbeille refusée (${trash.status}). ` +
        "Le compte de service doit avoir le rôle Gestionnaire sur le Drive partagé lui-même."
    );
  }

  async stat(ref: string): Promise<StoredObject | undefined> {
    const file = (await this.findSlotFiles(ref))[0];
    if (!file || file.size === undefined) return undefined;
    return { size: Number(file.size), fileId: file.id };
  }

  private async media(stored: StoredObject, headers: Record<string, string> = {}): Promise<Buffer> {
    if (!stored.fileId) throw new Error("Relais Google Drive : identifiant du fichier déposé manquant.");
    const res = await this.drive(
      "GET",
      `${DRIVE}/files/${encodeURIComponent(stored.fileId)}?alt=media&supportsAllDrives=true`,
      { headers }
    );
    if (!res.ok) await this.fail("lecture du fichier déposé", res);
    return Buffer.from(await res.arrayBuffer());
  }

  async head(stored: StoredObject, bytes: number): Promise<Buffer> {
    return (await this.media(stored, { Range: `bytes=0-${bytes - 1}` })).subarray(0, bytes);
  }

  async read(stored: StoredObject): Promise<Buffer> {
    return this.media(stored);
  }

  async purge(ref: string, stored?: StoredObject): Promise<PurgeOutcome> {
    // files.delete is permanent (no trash) and needs the `organizer` role
    // ("Gestionnaire") on the shared drive; `deleteFile` falls back to the trash.
    // Delete by id first: on a real Workspace (2026-11-27) the search by tag
    // missed files uploaded seconds earlier, so a search-only purge left them.
    const outcomes: PurgeOutcome[] = [];
    if (stored?.fileId) outcomes.push(await this.deleteFile(stored.fileId));
    for (const file of await this.findSlotFiles(ref)) {
      if (file.id !== stored?.fileId) outcomes.push(await this.deleteFile(file.id));
    }
    return outcomes.includes("trashed") ? "trashed" : "deleted";
  }

  /**
   * The resumable session URI stays usable after the slot expired, so a late
   * PUT can still create a file no slot will purge; a restart loses the slots
   * too. The transit folder is dedicated: delete every file older than the TTL.
   */
  async sweepStale(olderThan: Date): Promise<void> {
    // RFC 3339 without milliseconds, the form the Drive query examples use.
    const cutoff = olderThan.toISOString().replace(/\.\d{3}Z$/, "Z");
    for (const file of await this.listTransit(`createdTime < '${cutoff}'`)) await this.deleteFile(file.id);
  }
}

// ---------------------------------------------------------------------------
// Configuration and slot registry
// ---------------------------------------------------------------------------

/** The configured backend, or a French explanation of why there is none. */
export function relayFromEnv(env: NodeJS.ProcessEnv = process.env): RelayBackend | string {
  const kind = (readString("BOOND_MCP_UPLOAD_RELAY", env) ?? "").toLowerCase();
  if (kind === "") {
    return "Relais d'upload désactivé : l'opérateur du serveur doit définir `BOOND_MCP_UPLOAD_RELAY` (valeurs : `sharepoint`, `gdrive`).";
  }
  if (kind === "gdrive") return googleDriveRelayFromEnv(env);
  if (kind !== "sharepoint") {
    return `Relais d'upload inconnu : « ${kind} » (valeurs acceptées : \`sharepoint\`, \`gdrive\`).`;
  }
  const required = {
    tenantId: "BOOND_MCP_SHAREPOINT_TENANT_ID",
    clientId: "BOOND_MCP_SHAREPOINT_CLIENT_ID",
    clientSecret: "BOOND_MCP_SHAREPOINT_CLIENT_SECRET",
    site: "BOOND_MCP_SHAREPOINT_SITE",
  } as const;
  const missing = Object.values(required).filter((name) => !readString(name, env));
  if (missing.length > 0) {
    return `Relais SharePoint incomplet : variable(s) manquante(s) ${missing.map((m) => `\`${m}\``).join(", ")}.`;
  }
  return new SharePointRelay({
    tenantId: readString(required.tenantId, env) as string,
    clientId: readString(required.clientId, env) as string,
    clientSecret: readString(required.clientSecret, env) as string,
    site: normalizeSiteKey(readString(required.site, env) as string),
    library: readString("BOOND_MCP_SHAREPOINT_LIBRARY", env) ?? "Documents",
  });
}

function googleDriveRelayFromEnv(env: NodeJS.ProcessEnv): RelayBackend | string {
  const names = ["BOOND_MCP_GDRIVE_SERVICE_ACCOUNT_KEY", "BOOND_MCP_GDRIVE_FOLDER_ID"] as const;
  const missing = names.filter((name) => !readString(name, env));
  if (missing.length > 0) {
    return `Relais Google Drive incomplet : variable(s) manquante(s) ${missing.map((m) => `\`${m}\``).join(", ")}.`;
  }
  const key = parseServiceAccountKey(readString(names[0], env) as string);
  if (typeof key === "string") return key;
  return new GoogleDriveRelay({ ...key, folderId: (readString(names[1], env) as string).trim() });
}

interface Slot {
  backend: RelayBackend;
  handle: SlotHandle;
  filename: string;
}

export interface CreatedSlot {
  uploadSlot: string;
  uploadUrl: string;
  expiresAt: string;
  maxBytes: number;
  filename: string;
}

export interface ClaimedUpload {
  /** Pre-authenticated URL handed to BoondManager as `fileUrl`. */
  downloadUrl?: string;
  /** The bytes, when the store has no such URL (sent as a multipart file). */
  data?: Buffer;
  filename: string;
  contentType: string;
  size: number;
  /** Purge the stored object; call once BoondManager has fetched it. */
  release: () => Promise<PurgeOutcome | void>;
}

/**
 * In-memory registry of open slots. Single-use: a claimed slot is removed
 * before BoondManager is called, so a retry needs a new slot. Expired slots
 * are purged opportunistically whenever a new one is created.
 */
export class UploadRelay {
  private readonly slots = new Map<string, Slot>();
  private cachedBackend?: RelayBackend;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private backend(): RelayBackend {
    if (this.cachedBackend) return this.cachedBackend;
    const resolved = relayFromEnv(this.env);
    if (typeof resolved === "string") throw new UploadRejectedError(resolved);
    this.cachedBackend = resolved;
    return resolved;
  }

  private maxBytes(): number {
    return readPositiveInt("BOOND_MCP_UPLOAD_MAX_BYTES", DEFAULT_UPLOAD_MAX_BYTES, this.env);
  }

  private async sweep(backend: RelayBackend): Promise<void> {
    const now = Date.now();
    for (const [id, slot] of this.slots) {
      if (slot.handle.expiresAt.getTime() <= now) {
        this.slots.delete(id);
        await slot.backend
          .purge(slot.handle.ref)
          .catch((error: unknown) => logger.warn({ err: String(error) }, "upload relay: expired slot not purged"));
      }
    }
    await backend
      .sweepStale?.(new Date(now - SLOT_TTL_MS))
      .catch((error: unknown) => logger.warn({ err: String(error) }, "upload relay: stale sweep failed"));
  }

  async open(filename: string): Promise<CreatedSlot> {
    const backend = this.backend();
    const ext = extname(filename).toLowerCase();
    if (ext === "") {
      throw new UploadRejectedError("`fileName` doit comporter une extension (ex. « cv.pdf »).");
    }
    await this.sweep(backend);
    const uploadSlot = randomUUID();
    const clean = sanitizeSharePointName(filename);
    const handle = await backend.createSlot(uploadSlot, clean);
    this.slots.set(uploadSlot, { backend, handle, filename: clean });
    return {
      uploadSlot,
      uploadUrl: handle.uploadUrl,
      expiresAt: handle.expiresAt.toISOString(),
      maxBytes: this.maxBytes(),
      filename: clean,
    };
  }

  async claim(uploadSlot: string): Promise<ClaimedUpload> {
    const slot = this.slots.get(uploadSlot);
    if (!slot) {
      throw new UploadRejectedError(
        `\`uploadSlot\` inconnu ou déjà utilisé : « ${uploadSlot} ». Créer un nouveau slot avec \`boond_documents_upload_slot\`.`
      );
    }
    if (slot.handle.expiresAt.getTime() <= Date.now()) {
      this.slots.delete(uploadSlot);
      await slot.backend
        .purge(slot.handle.ref)
        .catch((e: unknown) => logger.warn({ err: String(e) }, "upload relay: expired slot not purged"));
      throw new UploadRejectedError("Slot d'upload expiré. Créer un nouveau slot avec `boond_documents_upload_slot`.");
    }
    const stored = await slot.backend.stat(slot.handle.ref, slot.filename);
    if (!stored) {
      // Not consumed: the upload may still be in flight.
      throw new UploadRejectedError(
        "Aucun fichier dans le dossier de transit de ce slot : le dépôt n'est pas terminé ou n'a pas eu lieu. " +
          "Exécuter la commande d'upload (réponse HTTP 200/201 attendue), puis réessayer."
      );
    }
    const purge = () => slot.backend.purge(slot.handle.ref, stored);
    /** Purge after a refusal; a failed purge is logged and named in the refusal, never hidden. */
    const purgeAfterRefusal = async (error: unknown): Promise<never> => {
      const failure = await purge().then(
        () => undefined,
        (e: unknown) => (e instanceof Error ? e.message : String(e))
      );
      if (failure === undefined) throw error;
      logger.warn({ err: failure }, "upload relay: transit copy not purged");
      const note = ` (⚠️ copie de transit NON supprimée : ${failure} — à supprimer à la main dans le stockage du relais)`;
      const message = (error instanceof Error ? error.message : String(error)) + note;
      throw error instanceof UploadRejectedError ? new UploadRejectedError(message) : new Error(message);
    };
    this.slots.delete(uploadSlot);
    try {
      const max = this.maxBytes();
      if (stored.size > max) {
        throw new UploadRejectedError(
          `Fichier trop volumineux : ${(stored.size / 1024 / 1024).toFixed(1)} Mo (max ${(max / 1024 / 1024).toFixed(1)} Mo).`
        );
      }
      const head = await slot.backend.head(stored, 16);
      const sniffed = sniffDocumentType(head, slot.filename);
      if (!sniffed || !sniffed.extensions.includes(extname(slot.filename).toLowerCase())) {
        throw new UploadRejectedError(
          `Format non accepté pour « ${slot.filename} » : le contenu déposé ne correspond pas à un format autorisé ` +
            "ou à son extension."
        );
      }
      let data: Buffer | undefined;
      if (stored.downloadUrl === undefined) {
        if (!slot.backend.read) throw new Error(`Relais ${slot.backend.name} : aucun moyen de lire le fichier déposé.`);
        data = await slot.backend.read(stored);
        if (data.length > max) {
          throw new UploadRejectedError(
            `Fichier trop volumineux : ${(data.length / 1024 / 1024).toFixed(1)} Mo (max ${(max / 1024 / 1024).toFixed(1)} Mo).`
          );
        }
      }
      return {
        ...(stored.downloadUrl !== undefined ? { downloadUrl: stored.downloadUrl } : {}),
        ...(data !== undefined ? { data } : {}),
        filename: slot.filename,
        contentType: sniffed.contentType,
        size: stored.size,
        release: purge,
      };
    } catch (error) {
      return purgeAfterRefusal(error);
    }
  }
}

/** Process-wide registry (one server process = one set of slots). */
export const uploadRelay = new UploadRelay();
