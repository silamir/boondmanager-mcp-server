import { describe, it, expect, vi, afterEach } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import {
  GoogleDriveRelay,
  parseServiceAccountKey,
  serviceAccountAssertion,
  normalizeSiteKey,
  relayFromEnv,
  sanitizeSharePointName,
  SharePointRelay,
  UploadRelay,
  SLOT_TTL_MS,
} from "./upload-relay.js";
import type { RelayBackend, StoredObject } from "./upload-relay.js";
import { UploadRejectedError } from "./upload-source.js";

const PDF_HEAD = Buffer.from("%PDF-1.7\n%âãÏÓ\n");
const SP_ENV = {
  BOOND_MCP_UPLOAD_RELAY: "sharepoint",
  BOOND_MCP_SHAREPOINT_TENANT_ID: "tenant",
  BOOND_MCP_SHAREPOINT_CLIENT_ID: "client",
  BOOND_MCP_SHAREPOINT_CLIENT_SECRET: "s3cr3t-value",
  BOOND_MCP_SHAREPOINT_SITE: "https://contoso.sharepoint.com/sites/Boond-Transfert",
  BOOND_MCP_SHAREPOINT_LIBRARY: "Transit",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("helpers", () => {
  it("normalizes every usual way of writing a site into a Graph site key", () => {
    const key = "contoso.sharepoint.com:/sites/Boond-Transfert";
    expect(normalizeSiteKey("https://contoso.sharepoint.com/sites/Boond-Transfert/")).toBe(key);
    expect(normalizeSiteKey("contoso.sharepoint.com/sites/Boond-Transfert")).toBe(key);
    expect(normalizeSiteKey(key)).toBe(key);
  });

  it("replaces characters SharePoint forbids and never returns an empty name", () => {
    expect(sanitizeSharePointName('CV "Dupont" #1: v2?.pdf')).toBe("CV _Dupont_ _1_ v2_.pdf");
    expect(sanitizeSharePointName("..\\..\\a|b.pdf")).toBe("_.._a_b.pdf");
    expect(sanitizeSharePointName("...")).toBe("document");
  });
});

describe("relayFromEnv", () => {
  it("is off without BOOND_MCP_UPLOAD_RELAY and rejects unknown backends", () => {
    expect(relayFromEnv({})).toMatch(/désactivé/);
    expect(relayFromEnv({ BOOND_MCP_UPLOAD_RELAY: "dropbox" })).toMatch(/inconnu/);
  });

  it("names every missing SharePoint variable, never their values", () => {
    const msg = relayFromEnv({ BOOND_MCP_UPLOAD_RELAY: "sharepoint", BOOND_MCP_SHAREPOINT_TENANT_ID: "t" });
    expect(msg).toMatch(/BOOND_MCP_SHAREPOINT_CLIENT_ID/);
    expect(msg).toMatch(/BOOND_MCP_SHAREPOINT_CLIENT_SECRET/);
    expect(msg).toMatch(/BOOND_MCP_SHAREPOINT_SITE/);
  });

  it("builds a SharePoint backend when complete", () => {
    const relay = relayFromEnv(SP_ENV);
    expect(relay).toBeInstanceOf(SharePointRelay);
  });
});

/** In-memory backend: `uploaded` simulates the client's PUT. */
function fakeBackend(head: Buffer = PDF_HEAD) {
  const store = new Map<string, StoredObject>();
  const backend: RelayBackend & { purged: string[]; upload: (ref: string, size: number) => void } = {
    name: "fake",
    purged: [],
    upload(ref, size) {
      store.set(ref, { size, downloadUrl: `https://store/${ref}?sig=x` });
    },
    createSlot: vi.fn(async (slotId: string) => ({
      ref: `ref-${slotId}`,
      uploadUrl: `https://store/upload/${slotId}`,
      expiresAt: new Date(Date.now() + SLOT_TTL_MS),
    })),
    stat: vi.fn(async (ref: string) => store.get(ref)),
    head: vi.fn(async () => head),
    purge: vi.fn(async (ref: string) => {
      backend.purged.push(ref);
      store.delete(ref);
    }),
  };
  return backend;
}

function relayWith(backend: RelayBackend, env: NodeJS.ProcessEnv = {}) {
  const relay = new UploadRelay(env);
  (relay as unknown as { cachedBackend: RelayBackend }).cachedBackend = backend;
  return relay;
}

describe("UploadRelay", () => {
  it("opens a slot, then hands out a checked download URL exactly once", async () => {
    const backend = fakeBackend();
    const relay = relayWith(backend);
    const slot = await relay.open("cv.pdf");
    expect(slot.uploadSlot).toMatch(/^[0-9a-f-]{36}$/);
    backend.upload(`ref-${slot.uploadSlot}`, 42_000);

    const claimed = await relay.claim(slot.uploadSlot);
    expect(claimed).toMatchObject({
      downloadUrl: `https://store/ref-${slot.uploadSlot}?sig=x`,
      contentType: "application/pdf",
      size: 42_000,
      filename: "cv.pdf",
    });
    await claimed.release();
    expect(backend.purged).toEqual([`ref-${slot.uploadSlot}`]);
    await expect(relay.claim(slot.uploadSlot)).rejects.toThrow(/inconnu ou déjà utilisé/);
  });

  it("keeps the slot open when nothing has been uploaded yet", async () => {
    const backend = fakeBackend();
    const relay = relayWith(backend);
    const slot = await relay.open("cv.pdf");
    await expect(relay.claim(slot.uploadSlot)).rejects.toThrow(/Aucun fichier dans le dossier de transit/);
    backend.upload(`ref-${slot.uploadSlot}`, 10);
    await expect(relay.claim(slot.uploadSlot)).resolves.toMatchObject({ size: 10 });
  });

  it("purges and refuses an oversize file or content that is not the declared document", async () => {
    const big = fakeBackend();
    const relay = relayWith(big, { BOOND_MCP_UPLOAD_MAX_BYTES: "1000" });
    const s1 = await relay.open("cv.pdf");
    big.upload(`ref-${s1.uploadSlot}`, 5000);
    await expect(relay.claim(s1.uploadSlot)).rejects.toThrow(/trop volumineux/);
    expect(big.purged).toContain(`ref-${s1.uploadSlot}`);

    const script = fakeBackend(Buffer.from("#!/bin/sh\necho"));
    const relay2 = relayWith(script);
    const s2 = await relay2.open("cv.pdf");
    script.upload(`ref-${s2.uploadSlot}`, 20);
    await expect(relay2.claim(s2.uploadSlot)).rejects.toThrow(/Format non accepté/);
    expect(script.purged).toContain(`ref-${s2.uploadSlot}`);
  });

  it("expires slots and sweeps them when a new one is opened", async () => {
    vi.useFakeTimers();
    const backend = fakeBackend();
    const relay = relayWith(backend);
    const old = await relay.open("a.pdf");
    vi.advanceTimersByTime(SLOT_TTL_MS + 1);
    await expect(relay.claim(old.uploadSlot)).rejects.toThrow(/expiré/);
    expect(backend.purged).toContain(`ref-${old.uploadSlot}`);

    const stale = await relay.open("b.pdf");
    vi.advanceTimersByTime(SLOT_TTL_MS + 1);
    await relay.open("c.pdf");
    expect(backend.purged).toContain(`ref-${stale.uploadSlot}`);
  });

  it("requires an extension and reports a disabled relay as a refusal", async () => {
    await expect(relayWith(fakeBackend()).open("cv")).rejects.toThrow(/extension/);
    await expect(new UploadRelay({}).open("cv.pdf")).rejects.toBeInstanceOf(UploadRejectedError);
  });
});

/** A scripted Graph: routes by method + URL prefix, records every call. */
type Route = [string, (init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> }];

function stubGraph(routes: Route[]) {
  const calls: Array<{ method: string; url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({ method, url, init });
      const route = routes.find(([key]) => `${method} ${url}`.startsWith(key));
      if (!route) throw new Error(`unexpected ${method} ${url}`);
      const { status, body, headers } = route[1](init);
      const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
      return new Response(status === 204 || status === 302 ? null : text, { status, headers: headers ?? {} });
    })
  );
  return calls;
}

const G = "https://graph.microsoft.com/v1.0";
const baseRoutes: Route[] = [
  [
    "POST https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
    () => ({ status: 200, body: { access_token: "tok", expires_in: 3600 } }),
  ],
  [`GET ${G}/sites/contoso.sharepoint.com:/sites/Boond-Transfert`, () => ({ status: 200, body: { id: "site1" } })],
  [
    `GET ${G}/sites/site1/drives`,
    () => ({
      status: 200,
      body: {
        value: [
          { id: "d-docs", name: "Documents", webUrl: "https://c/sites/B/Shared%20Documents" },
          { id: "d-transit", name: "Transit", webUrl: "https://c/sites/B/Transit" },
        ],
      },
    }),
  ],
];

function spRelay() {
  const relay = relayFromEnv(SP_ENV);
  if (typeof relay === "string") throw new Error(relay);
  return relay;
}

describe("SharePointRelay (Graph)", () => {
  it("creates one folder per slot and an upload session named after the file", async () => {
    const calls = stubGraph([
      ...baseRoutes,
      [`POST ${G}/drives/d-transit/root/children`, () => ({ status: 201, body: { id: "folder1" } })],
      [
        `POST ${G}/drives/d-transit/items/folder1:/CV%20Dupont.pdf:/createUploadSession`,
        () => ({
          status: 200,
          body: {
            uploadUrl: "https://contoso.sharepoint.com/up?tempauth=z",
            expirationDateTime: "2099-01-01T00:00:00Z",
          },
        }),
      ],
    ]);
    const handle = await spRelay().createSlot("abc", "CV Dupont.pdf");
    expect(handle.ref).toBe("folder1");
    expect(handle.uploadUrl).toBe("https://contoso.sharepoint.com/up?tempauth=z");
    expect(handle.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + SLOT_TTL_MS);

    const token = calls[0]!;
    expect(String(token.init.body)).toContain("grant_type=client_credentials");
    expect(String(token.init.body)).toContain("scope=https%3A%2F%2Fgraph.microsoft.com%2F.default");
    const folder = calls.find((c) => c.url.endsWith("/root/children"))!;
    expect(JSON.parse(String(folder.init.body))).toMatchObject({ name: "mcp-abc", folder: {} });
    expect((folder.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("finds the upload by listing the slot folder, whatever SharePoint named it", async () => {
    stubGraph([
      ...baseRoutes,
      [
        `GET ${G}/drives/d-transit/items/folder1/children`,
        () => ({
          status: 200,
          body: {
            value: [
              { id: "sub", name: "x", folder: {} },
              {
                id: "i1",
                name: "Test_Signature_PDF (1).pdf",
                size: 13115,
                file: {},
                "@microsoft.graph.downloadUrl": "https://dl?tempauth=q",
              },
            ],
          },
        }),
      ],
      [`GET ${G}/drives/d-transit/items/folder2/children`, () => ({ status: 200, body: { value: [] } })],
      [
        `GET ${G}/drives/d-transit/items/gone/children`,
        () => ({ status: 404, body: { error: { code: "itemNotFound" } } }),
      ],
    ]);
    const relay = spRelay();
    await expect(relay.stat("folder1", "Test_Signature_PDF.pdf")).resolves.toEqual({
      size: 13115,
      downloadUrl: "https://dl?tempauth=q",
    });
    await expect(relay.stat("folder2", "cv.pdf")).resolves.toBeUndefined();
    await expect(relay.stat("gone", "cv.pdf")).rejects.toThrow(/Dossier de transit du slot introuvable/);
  });

  it("falls back to the /content redirect when the listing omits the download URL", async () => {
    const calls = stubGraph([
      ...baseRoutes,
      [
        `GET ${G}/drives/d-transit/items/folder1/children`,
        () => ({ status: 200, body: { value: [{ id: "i1", name: "cv.pdf", size: 42, file: {} }] } }),
      ],
      [
        `GET ${G}/drives/d-transit/items/i1/content`,
        () => ({ status: 302, headers: { location: "https://dl?tempauth=r" } }),
      ],
      [
        `GET ${G}/drives/d-transit/items/folder3/children`,
        () => ({ status: 200, body: { value: [{ id: "i3", name: "cv.pdf", size: 42, file: {} }] } }),
      ],
      [`GET ${G}/drives/d-transit/items/i3/content`, () => ({ status: 200, body: "raw" })],
    ]);
    const relay = spRelay();
    await expect(relay.stat("folder1", "cv.pdf")).resolves.toEqual({ size: 42, downloadUrl: "https://dl?tempauth=r" });
    const content = calls.find((c) => c.url.endsWith("/i1/content"))!;
    expect(content.init.redirect).toBe("manual");
    await expect(relay.stat("folder3", "cv.pdf")).rejects.toThrow(/ne fournit pas d'URL de lecture/);
  });

  it("purges permanently, falling back to a plain delete when permanentDelete is refused", async () => {
    const calls = stubGraph([
      ...baseRoutes,
      [`POST ${G}/drives/d-transit/items/f1/permanentDelete`, () => ({ status: 204 })],
      [
        `POST ${G}/drives/d-transit/items/f2/permanentDelete`,
        () => ({ status: 403, body: { error: { code: "accessDenied" } } }),
      ],
      [`DELETE ${G}/drives/d-transit/items/f2`, () => ({ status: 204 })],
    ]);
    const relay = spRelay();
    await relay.purge("f1");
    await relay.purge("f2");
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([`${G}/drives/d-transit/items/f2`]);
  });

  it("explains a missing library by listing the ones found", async () => {
    stubGraph([...baseRoutes]);
    const relay = relayFromEnv({ ...SP_ENV, BOOND_MCP_SHAREPOINT_LIBRARY: "Nope" });
    if (typeof relay === "string") throw new Error(relay);
    await expect(relay.createSlot("x", "cv.pdf")).rejects.toThrow(/« Nope » introuvable.*Documents, Transit/);
  });

  it("never leaks the client secret when Entra ID refuses the token", async () => {
    stubGraph([
      [
        "POST https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
        () => ({ status: 401, body: { error: "invalid_client", error_description: "secret s3cr3t-value bad" } }),
      ],
    ]);
    const error = await spRelay()
      .createSlot("x", "cv.pdf")
      .catch((e: Error) => e);
    expect(String(error)).toContain("invalid_client");
    expect(String(error)).not.toContain("s3cr3t-value");
  });
});

// ---------------------------------------------------------------------------
// Google Drive backend
// ---------------------------------------------------------------------------

const { privateKey: TEST_PRIVATE_KEY, publicKey: TEST_PUBLIC_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const SA_KEY = JSON.stringify({ client_email: "relay@projet.iam.gserviceaccount.com", private_key: TEST_PRIVATE_KEY });
const GD_ENV = {
  BOOND_MCP_UPLOAD_RELAY: "gdrive",
  BOOND_MCP_GDRIVE_SERVICE_ACCOUNT_KEY: SA_KEY,
  BOOND_MCP_GDRIVE_FOLDER_ID: "folderX",
};
const D = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const SLOT = "0f0e0d0c-0b0a-4908-8706-050403020100";

function gdrive() {
  return new GoogleDriveRelay({
    clientEmail: "relay@projet.iam.gserviceaccount.com",
    privateKey: TEST_PRIVATE_KEY,
    folderId: "folderX",
  });
}

const gdriveBase: Route[] = [
  [
    "POST https://oauth2.googleapis.com/token",
    () => ({ status: 200, body: { access_token: "gtok", expires_in: 3600 } }),
  ],
  [
    `GET ${D}/files/folderX?`,
    () => ({ status: 200, body: { id: "folderX", driveId: "drive0", mimeType: FOLDER_MIME } }),
  ],
];

describe("Google Drive relay: configuration", () => {
  it("names the missing variables, and builds a backend when complete", () => {
    const msg = relayFromEnv({ BOOND_MCP_UPLOAD_RELAY: "gdrive" });
    expect(msg).toMatch(/BOOND_MCP_GDRIVE_SERVICE_ACCOUNT_KEY/);
    expect(msg).toMatch(/BOOND_MCP_GDRIVE_FOLDER_ID/);
    expect(relayFromEnv(GD_ENV)).toBeInstanceOf(GoogleDriveRelay);
    expect(relayFromEnv({ BOOND_MCP_UPLOAD_RELAY: "dropbox" })).toMatch(/`gdrive`/);
  });

  it("refuses an unusable key without echoing it", () => {
    const bad = relayFromEnv({ ...GD_ENV, BOOND_MCP_GDRIVE_SERVICE_ACCOUNT_KEY: "not-json-secret" });
    expect(bad).toMatch(/JSON valide/);
    expect(bad).not.toContain("not-json-secret");
    expect(parseServiceAccountKey("{}")).toMatch(/client_email/);
  });

  it("signs an RS256 JWT bearer assertion for the Drive scope", () => {
    const jwt = serviceAccountAssertion({ clientEmail: "a@b", privateKey: TEST_PRIVATE_KEY }, 1_000_000);
    const [h, c, sig] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({
      iss: "a@b",
      scope: "https://www.googleapis.com/auth/drive",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1000,
      exp: 4600,
    });
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(TEST_PUBLIC_KEY, Buffer.from(sig, "base64url"))).toBe(
      true
    );
  });
});

describe("Google Drive relay: slot lifecycle", () => {
  it("opens a resumable session in the shared-drive folder, tagged with the slot", async () => {
    const calls = stubGraph([
      ...gdriveBase,
      [
        "POST https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true",
        () => ({
          status: 200,
          headers: { location: "https://www.googleapis.com/upload/drive/v3/files?upload_id=abc" },
        }),
      ],
    ]);
    const handle = await gdrive().createSlot(SLOT, "facture.pdf");
    expect(handle.ref).toBe(SLOT);
    expect(handle.uploadUrl).toBe("https://www.googleapis.com/upload/drive/v3/files?upload_id=abc");
    const init = calls.find((c) => c.url.includes("uploadType=resumable"))!;
    expect(JSON.parse(init.init.body as string)).toEqual({
      name: "facture.pdf",
      parents: ["folderX"],
      appProperties: { boondMcpSlot: SLOT },
    });
    expect((init.init.headers as Record<string, string>).Authorization).toBe("Bearer gtok");
  });

  it("refuses a transit folder outside a shared drive", async () => {
    stubGraph([
      gdriveBase[0]!,
      [`GET ${D}/files/folderX?`, () => ({ status: 200, body: { id: "folderX", mimeType: FOLDER_MIME } })],
    ]);
    await expect(gdrive().createSlot(SLOT, "a.pdf")).rejects.toThrow(/Drive partagé/);
  });

  it("finds the uploaded file by its slot tag, reads its head and content with the token", async () => {
    const calls = stubGraph([
      ...gdriveBase,
      [`GET ${D}/files?`, () => ({ status: 200, body: { files: [{ id: "f1", name: "facture.pdf", size: "42" }] } })],
      [
        `GET ${D}/files/f1?alt=media`,
        (init) => ({ status: (init.headers as Record<string, string>).Range ? 206 : 200, body: "%PDF-1.7 content" }),
      ],
    ]);
    const relay = gdrive();
    const stored = await relay.stat(SLOT);
    expect(stored).toEqual({ size: 42, fileId: "f1" });
    const list = new URL(calls.find((c) => c.url.startsWith(`${D}/files?`))!.url);
    expect(list.searchParams.get("q")).toBe(
      `'folderX' in parents and appProperties has { key='boondMcpSlot' and value='${SLOT}' } and trashed=false`
    );
    expect(list.searchParams.get("driveId")).toBe("drive0");
    expect(list.searchParams.get("supportsAllDrives")).toBe("true");
    expect((await relay.head(stored!, 4)).toString()).toBe("%PDF");
    expect((await relay.read(stored!)).toString()).toBe("%PDF-1.7 content");
    const ranged = calls.find((c) => (c.init.headers as Record<string, string> | undefined)?.Range);
    expect((ranged!.init.headers as Record<string, string>).Range).toBe("bytes=0-3");
  });

  it("reports nothing uploaded yet when the slot has no file", async () => {
    stubGraph([...gdriveBase, [`GET ${D}/files?`, () => ({ status: 200, body: { files: [] } })]]);
    await expect(gdrive().stat(SLOT)).resolves.toBeUndefined();
  });

  it("purges with files.delete (permanent) when it is allowed, without touching the trash", async () => {
    const calls = stubGraph([
      ...gdriveBase,
      [`GET ${D}/files?`, () => ({ status: 200, body: { files: [{ id: "f1" }] } })],
      [`DELETE ${D}/files/f1?supportsAllDrives=true`, () => ({ status: 204 })],
    ]);
    await gdrive().purge(SLOT);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      `${D}/files/f1?supportsAllDrives=true`,
    ]);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("fails loudly when the permanent delete is refused (role below organizer)", async () => {
    stubGraph([
      ...gdriveBase,
      [`GET ${D}/files?`, () => ({ status: 200, body: { files: [{ id: "f1" }] } })],
      [`DELETE ${D}/files/f1`, () => ({ status: 403, body: { error: { message: "insufficientFilePermissions" } } })],
      [`PATCH ${D}/files/f1`, () => ({ status: 403, body: {} })],
    ]);
    await expect(gdrive().purge(SLOT)).rejects.toThrow(/suppression définitive.*403/);
  });

  it("never echoes the signed assertion when the token is refused", async () => {
    stubGraph([
      ["POST https://oauth2.googleapis.com/token", () => ({ status: 400, body: { error: "invalid_grant" } })],
    ]);
    const err = await gdrive()
      .createSlot(SLOT, "a.pdf")
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/invalid_grant/);
    expect((err as Error).message).not.toMatch(/eyJ/);
  });
});

describe("UploadRelay with a store without download URL", () => {
  it("reads the bytes, checks them, and hands them out instead of a URL", async () => {
    const content = Buffer.concat([PDF_HEAD, Buffer.from("rest")]);
    const backend = fakeBackend();
    backend.stat = vi.fn(async () => ({ size: content.length, fileId: "f1" }));
    const withRead = { ...backend, read: vi.fn(async () => content) };
    const relay = relayWith(withRead);
    const slot = await relay.open("facture.pdf");
    const claimed = await relay.claim(slot.uploadSlot);
    expect(claimed.downloadUrl).toBeUndefined();
    expect(claimed.data).toEqual(content);
    expect(claimed.contentType).toBe("application/pdf");
  });

  it("purges and refuses when the read content exceeds the cap", async () => {
    const backend = fakeBackend();
    backend.stat = vi.fn(async () => ({ size: 10, fileId: "f1" }));
    const withRead = { ...backend, read: vi.fn(async () => Buffer.alloc(2048)) };
    const relay = relayWith(withRead, { BOOND_MCP_UPLOAD_MAX_BYTES: "1024" });
    const slot = await relay.open("facture.pdf");
    await expect(relay.claim(slot.uploadSlot)).rejects.toThrow(/trop volumineux/);
    expect(backend.purge).toHaveBeenCalled();
  });
});

describe("Google Drive relay: error paths and housekeeping", () => {
  it("refuses a transit id that is not a folder, or not reachable", async () => {
    stubGraph([
      gdriveBase[0]!,
      [`GET ${D}/files/folderX?`, () => ({ status: 200, body: { driveId: "drive0", mimeType: "application/pdf" } })],
    ]);
    await expect(gdrive().createSlot(SLOT, "a.pdf")).rejects.toThrow(/ne désigne pas un dossier/);
    stubGraph([gdriveBase[0]!, [`GET ${D}/files/folderX?`, () => ({ status: 404, body: {} })]]);
    await expect(gdrive().createSlot(SLOT, "a.pdf")).rejects.toThrow(/dossier de transit introuvable/);
  });

  it("explains a refused upload session and a session without Location", async () => {
    stubGraph([
      ...gdriveBase,
      [`POST https://www.googleapis.com/upload/`, () => ({ status: 403, body: { error: { message: "denied" } } })],
    ]);
    await expect(gdrive().createSlot(SLOT, "a.pdf")).rejects.toThrow(/ouverture de la session d'upload → 403 denied/);
    stubGraph([...gdriveBase, [`POST https://www.googleapis.com/upload/`, () => ({ status: 200 })]]);
    await expect(gdrive().createSlot(SLOT, "a.pdf")).rejects.toThrow(/pas renvoyé d'URL de dépôt/);
  });

  it("surfaces a failed listing, tolerates an already-deleted file, and reuses its token", async () => {
    const calls = stubGraph([
      ...gdriveBase,
      [`GET ${D}/files?`, () => ({ status: 200, body: { files: [{ id: "f1" }, { id: "f2" }] } })],
      [`DELETE ${D}/files/f1`, () => ({ status: 404, body: {} })],
      [`GET ${D}/files/f1?fields=id`, () => ({ status: 404, body: {} })],
      [`DELETE ${D}/files/f2`, () => ({ status: 204 })],
    ]);
    const relay = gdrive();
    await relay.purge(SLOT);
    await relay.purge(SLOT);
    expect(calls.filter((c) => c.url.startsWith("https://oauth2.googleapis.com/token"))).toHaveLength(1);
    stubGraph([...gdriveBase, [`GET ${D}/files?`, () => ({ status: 500, body: { error: { message: "boom" } } })]]);
    await expect(gdrive().stat(SLOT)).rejects.toThrow(/recherche du fichier déposé → 500 boom/);
  });

  it("deletes stale files of the transit folder (late uploads, lost slots)", async () => {
    const calls = stubGraph([
      ...gdriveBase,
      [`GET ${D}/files?`, () => ({ status: 200, body: { files: [{ id: "old1" }] } })],
      [`DELETE ${D}/files/old1`, () => ({ status: 204 })],
    ]);
    await gdrive().sweepStale(new Date("2026-11-27T10:00:00.000Z"));
    const list = new URL(calls.find((c) => c.url.startsWith(`${D}/files?`))!.url);
    expect(list.searchParams.get("q")).toBe(
      "'folderX' in parents and createdTime < '2026-11-27T10:00:00Z' and trashed=false"
    );
    expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/old1"))).toBe(true);
  });

  it("runs the backend's stale sweep whenever a slot opens", async () => {
    const backend = fakeBackend();
    const sweepStale = vi.fn(async (_olderThan: Date) => undefined);
    const relay = relayWith({ ...backend, sweepStale });
    await relay.open("a.pdf");
    expect(sweepStale).toHaveBeenCalledTimes(1);
    const cutoff = sweepStale.mock.calls[0]?.[0] ?? new Date();
    expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(SLOT_TTL_MS - 1000);
  });
});

describe("purge robustness (observed on a real Workspace, 2026-11-27)", () => {
  it("deletes the stored file by id even when the tag search does not see it yet", async () => {
    const calls = stubGraph([
      ...gdriveBase,
      [`GET ${D}/files?`, () => ({ status: 200, body: { files: [] } })],
      [`DELETE ${D}/files/fresh1`, () => ({ status: 204 })],
    ]);
    await gdrive().purge(SLOT, { size: 10, fileId: "fresh1" });
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      `${D}/files/fresh1?supportsAllDrives=true`,
    ]);
  });

  it("names a failed purge in the refusal instead of hiding it", async () => {
    const backend = fakeBackend(Buffer.from("not a pdf at all"));
    backend.purge = vi.fn(async () => {
      throw new Error("Relais Google Drive : suppression définitive du fichier déposé → 403");
    });
    const relay = relayWith(backend);
    const slot = await relay.open("facture.pdf");
    backend.upload(`ref-${slot.uploadSlot}`, 100);
    const err = await relay.claim(slot.uploadSlot).catch((e: Error) => e);
    expect(err).toBeInstanceOf(UploadRejectedError);
    expect((err as Error).message).toMatch(/Format non accepté/);
    expect((err as Error).message).toMatch(/NON supprimée.*403/);
  });

  it("hands the stored object to purge so the backend can delete by id", async () => {
    const backend = fakeBackend(Buffer.from("not a pdf at all"));
    const relay = relayWith(backend);
    const slot = await relay.open("facture.pdf");
    backend.upload(`ref-${slot.uploadSlot}`, 100);
    await relay.claim(slot.uploadSlot).catch(() => undefined);
    expect(backend.purge).toHaveBeenCalledWith(`ref-${slot.uploadSlot}`, expect.objectContaining({ size: 100 }));
  });
});

describe("Drive delete answering 404", () => {
  it("counts a 404 as deleted only when the file is really gone", async () => {
    stubGraph([
      ...gdriveBase,
      [`GET ${D}/files?`, () => ({ status: 200, body: { files: [{ id: "gone1" }] } })],
      [`DELETE ${D}/files/gone1`, () => ({ status: 404, body: {} })],
      [`GET ${D}/files/gone1?fields=id`, () => ({ status: 404, body: {} })],
    ]);
    await expect(gdrive().purge(SLOT)).resolves.toBe("deleted");
  });

  it("falls back to the trash when the permanent delete is refused, and logs it", async () => {
    const calls = stubGraph([
      ...gdriveBase,
      [`GET ${D}/files?`, () => ({ status: 200, body: { files: [{ id: "kept1" }] } })],
      [`DELETE ${D}/files/kept1`, () => ({ status: 404, body: {} })],
      [`GET ${D}/files/kept1?fields=id`, () => ({ status: 200, body: { id: "kept1" } })],
      [`PATCH ${D}/files/kept1?supportsAllDrives=true`, () => ({ status: 200, body: { id: "kept1" } })],
    ]);
    const { logger } = await import("./logger.js");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await expect(gdrive().purge(SLOT)).resolves.toBe("trashed");
    const patch = calls.find((c) => c.method === "PATCH");
    expect(JSON.parse(patch!.init.body as string)).toEqual({ trashed: true });
    expect(warn).toHaveBeenCalledWith({ status: 404 }, expect.stringMatching(/moved to the Drive trash/));
    warn.mockRestore();
  });

  it("reports a failure when both the permanent delete and the trash are refused", async () => {
    stubGraph([
      ...gdriveBase,
      [`GET ${D}/files?`, () => ({ status: 200, body: { files: [{ id: "kept1" }] } })],
      [`DELETE ${D}/files/kept1`, () => ({ status: 403, body: {} })],
      [`PATCH ${D}/files/kept1`, () => ({ status: 403, body: {} })],
    ]);
    await expect(gdrive().purge(SLOT)).rejects.toThrow(
      /définitive refusée \(403\) et mise à la corbeille refusée \(403\)/
    );
  });
});

describe("Drive trash fallback (not exercised on a real Workspace)", () => {
  it("trashes after a 403 on the permanent delete and reports it", async () => {
    const calls = stubGraph([
      ...gdriveBase,
      [`GET ${D}/files?`, () => ({ status: 200, body: { files: [{ id: "t1" }] } })],
      [`DELETE ${D}/files/t1`, () => ({ status: 403, body: {} })],
      [`PATCH ${D}/files/t1?supportsAllDrives=true`, () => ({ status: 200, body: { id: "t1" } })],
    ]);
    await expect(gdrive().purge(SLOT)).resolves.toBe("trashed");
    expect(calls.some((c) => c.method === "PATCH")).toBe(true);
  });

  it("trashes when the 404 check itself fails (neither gone nor confirmed)", async () => {
    stubGraph([
      ...gdriveBase,
      [`GET ${D}/files?`, () => ({ status: 200, body: { files: [{ id: "t2" }] } })],
      [`DELETE ${D}/files/t2`, () => ({ status: 404, body: {} })],
      [`GET ${D}/files/t2?fields=id`, () => ({ status: 500, body: {} })],
      [`PATCH ${D}/files/t2?supportsAllDrives=true`, () => ({ status: 200, body: { id: "t2" } })],
    ]);
    await expect(gdrive().purge(SLOT)).resolves.toBe("trashed");
  });

  it("reports deleted when every file was permanently deleted", async () => {
    stubGraph([
      ...gdriveBase,
      [`GET ${D}/files?`, () => ({ status: 200, body: { files: [{ id: "d1" }] } })],
      [`DELETE ${D}/files/d1`, () => ({ status: 204 })],
    ]);
    await expect(gdrive().purge(SLOT)).resolves.toBe("deleted");
  });
});
