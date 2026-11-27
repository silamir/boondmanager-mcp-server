---
paths:
  - "src/tools/documents.ts"
  - "src/services/document-text.ts"
  - "src/services/http/download.ts"
  - "src/services/upload-*.ts"
---

# Documents: download, text extraction, upload sources, upload relay

<!-- Moved verbatim from CLAUDE.md; loaded only when Claude works on the files above. -->

**Documents** (`src/tools/documents.ts`): `boond_documents_get` downloads a
document (CV, justificatif…) via `apiDownload()` and, since issue #263, makes
it **readable** by default (`mode: "text"`): a PDF goes through `unpdf` (a
serverless pdf.js build, ~2 MB, no native binary), a DOCX through
`src/services/document-text.ts`'s own zip reader (`node:zlib` only,
`word/document.xml` → paragraphs / tabs / decoded entities), both bounded at
`CHARACTER_LIMIT` with the original size and page count in the header; an
image (PNG / JPEG / GIF / WebP) is returned as MCP `image` content — the only
shape hosts hand to the model's vision input; a blob is opaque — up to
`MAX_IMAGE_BYTES` (2 MiB). BoondManager serves `.docx` resumes as
**`application/msword`** (observed 2026-09-26, #311), so `isDocxMime` also
accepts a `.docx` extension or the zip signature `PK\x03\x04` on a Word /
octet-stream mime; and its plain `filename="…"` carries UTF-8 (NFD) bytes
that `fetch` decodes as Latin-1 — `repairUtf8Filename` re-decodes and NFC-
normalises them ("FreÌdeÌric" → "Frédéric"). A PDF from which nothing extracts (scan,
encrypted, malformed) falls back to the raw embedded resource **with a
warning line**, never an error. `mode: "raw"` is the previous behaviour
(base64 blob for binaries, plain text for text mimes). Size cap on the
download itself: `MAX_DOCUMENT_BYTES` = 5 MiB. Fixtures for the tests are
built in code (`buildPdf`, `buildZip` in `document-text.test.ts`), no binary
files in the repository. The cap is handed to `apiDownload`
as `{ maxBytes }` and enforced **while downloading** (issue #235): a
`Content-Length` above it is refused before a body byte is read, and a body
without one is cancelled (`reader.cancel()`) the moment the running total
crosses it — both surface as `DownloadTooLargeError`, which the tool turns
into an `isError` result. Before, the whole file was buffered and *then*
measured, so a 200 MB document cost 200 MB of heap per concurrent call and
was only bounded by the 30 s timeout. Document ids are found in entity
tabs (e.g. `boond_candidates_information` → relations `resumes`/`files`).
`boond_documents_create` uploads from one of four sources (`fileUrl`,
`filePath`, `fileContent`, `uploadSlot` — see *Document Upload Sources* and
*Upload Relay* below), with `parsing: true` to trigger Boond's AI resume
parsing on `candidateResume`.
Delete goes through the factory (elicitation + structuredContent).

Document ids are the **one exception** to the numeric-id rule, and the two
halves of that exception have to stay together (issue #186):

- Relations expose them **suffixed** — `{"resumes":{"data":[{"id":"123_resume"}]}}`
  — so `boond_documents_get` validates with `DocumentIdSchema`
  (`/^\d+(_[A-Za-z]+)?$/`), not `IdSchema`. **Every other id-shaped input —
  `id` and every `*Id`, required or optional, top-level or nested — is
  `EntityIdSchema`** (`/^\d+$/`), whether the value ends up in a path segment,
  a `keywords` prefix (`COMP<id>`) or a JSON:API relationship. Fifteen update /
  get schemas used to be `z.string().min(1)` (issue #228): `assertSafeApiPath`
  allows `/`, so `id: "5/information"` produced `PUT /candidates/5/information`.
  `src/tools/id-schemas.test.ts` walks every advertised `inputSchema` over a
  real client and fails by tool name on any id without the numeric pattern —
  add a new id field with `EntityIdSchema`, not a fresh `z.string()`.
  The suffix alphabet stays letters-only so the id still can't smuggle a path
  segment / `..` / `?` / `#` into the API path; both cases are allowed because
  Boond derives the suffix from camelCase parent types (`administrativeFile`).
- BoondManager answers an **unknown** `/documents/<id>` with its app shell —
  HTTP 200, `text/html`, ~9 KB — instead of a 404, because `apiDownload` sends
  `Accept: */*` (it only 404s when JSON is explicitly requested). `isTextMime`
  accepts `text/html`, so that page used to be returned *as the document's
  text*: a truncated id looked like a corrupted CV, not a wrong id. `apiDownload`
  therefore refuses `text/html` **without** a `Content-Disposition` filename —
  a real file download carries one, the shell doesn't, so genuine HTML documents
  still work. Rejecting the suffixed id without this guard is what made the
  failure silent, hence: don't remove one without the other.

**`parentType` spelling** (`canonicalDocumentParentType`, `src/schemas/index.ts`):
BoondManager compared the type case-sensitively for the one type exercised
(2026-11-27: `providerInvoice` → 422 `parameter: parentType`, `providerinvoice`
→ document created); the other spellings come from the RAML, not exercised
one by one. The RAML list (`documents/search.raml`) mixes camelCase
(`expensesReport`) with three compound names written all-lowercase
(`providerinvoice`, `followeddocument`, `appentity`), so a model guesses wrong.
The handler maps a case-insensitive match of `DocumentParentTypes` to its
documented spelling before the upload (so a case slip no longer costs a relay
slot), and says so in the result; anything else
still goes through untouched (the list is guidance, not a guard). The field
description is generated from `DocumentParentTypeLabels` (every type with what
it designates). A 422 on `parentType` returns that list for an unknown type,
and for a documented one points at `parentId` first (Boond may name
`parentType` when the parent does not exist — not verified). Known limit: the
rewrite also applies to a retry with another casing, so if a RAML spelling
were wrong for the API that type could not be used through the MCP; the 422
message says so, and the correction note shows what was actually sent.

## Document Upload Sources

`boond_documents_create` takes exactly one of `fileUrl`, `filePath`, or
`fileContent` + `fileName`; the count is checked in the handler (a JSON Schema
`oneOf` would be unreadable for the model and is not needed). Guards live in
`src/services/upload-source.ts`:

- `filePath` is **off unless `BOOND_MCP_UPLOAD_DIRS` is set**, and always
  refused over HTTP (the server does not run on the user's machine there).
  Containment compares `realpath` on both sides — never a string prefix of the
  raw input — and appends a separator so `/allowed-evil` does not match
  `/allowed`.
- `fileContent` is capped at `INLINE_UPLOAD_MAX_BYTES` (2 MiB): base64 costs the
  model ~1.33 output characters per byte.
- Both are typed by magic bytes. The extension only disambiguates ZIP (OOXML /
  ODF) and OLE (legacy Office) containers, and must agree with the content.
- The multipart part name (`DOCUMENT_UPLOAD_FILE_FIELD = "file"`) is not
  documented by the RAML; it was confirmed on a production tenant (PDF attached
  to a candidate via `filePath`, visible and intact in the UI).
- `fileContent` only helps callers that already hold the exact bytes (scripts,
  agents with file access). A model cannot reliably re-emit a conversation
  attachment as base64: it rarely has the raw bytes, and one wrong character
  corrupts the file. Chat attachments need a transport that bypasses the
  model's output (upload slot), not a larger inline cap.

## Upload Relay (`boond_documents_upload_slot`)

Conversation attachments live in the MCP client's code-execution sandbox, not on
the server host; the model cannot re-emit them as base64. The relay
(`src/services/upload-relay.ts`) moves the bytes outside the model's output:
slot → sandbox `PUT` to a pre-authenticated URL → `boond_documents_create`
with `uploadSlot`, which hands Boond a short-lived download URL through the
existing `fileUrl` path and purges the stored copy in a `finally` (Boond
succeeded or not).

- Backends implement `RelayBackend` (`createSlot`, `stat`, `head`, `purge`);
  `SharePointRelay` (Graph, app-only client credentials, `Sites.Selected`) is
  the first. One folder per slot keeps the file's name intact: Boond names the
  document after the download's `Content-Disposition`.
- Slots are single-use and in memory (15 min). A claim before the upload has
  landed does **not** consume the slot; any other claim does. Expired slots are
  swept when a new one opens; with SharePoint a crash leaves `mcp-<uuid>`
  folders to clean by hand (the Drive backend sweeps its transit folder, below).
- The stored file is re-checked (size cap, magic bytes via a 16-byte ranged
  read) before Boond sees it; a refusal purges it.
- The parameter is `uploadSlot`, not `uploadId`: every `*Id` input must be a
  numeric Boond id (`id-schemas.test.ts`).
- Purge uses `permanentDelete` (no recycle bin: CVs, payslips), falling back
  to `DELETE`. Graph errors never echo the token request (it carries the
  secret).
- `stat` lists the slot folder rather than addressing the file by name, and
  takes the download URL from the listing or, failing that, from the 302 of
  `/content` (read with `redirect: "manual"`): on a production tenant the
  listing came back without the `@microsoft.graph.downloadUrl` annotation.
- Exercised on a production tenant: a PDF attached to a conversation reached a
  candidate intact, the transit library ended empty, and both recycle-bin
  stages stayed empty (`permanentDelete` works with `Sites.Selected` + `write`).
- **Google Drive backend** (`GoogleDriveRelay`, `BOOND_MCP_UPLOAD_RELAY=gdrive`):
  service account, JWT bearer grant signed with `node:crypto` (no Google SDK),
  scope `drive` (`drive.file` does not cover a human-created transit folder;
  reach is bounded by shared-drive membership). Checked against the Drive API
  docs (2026-11-27). Exercised on a real Workspace and a production Boond the
  same day (a test provider invoice approved by the user, not a sandbox): slot
  opening, the client's single token-less `PUT` with the returned `curl`
  command (`Content-Range` included), `stat`, ranged and full `read`, and the
  multipart hand-off — the PDF landed on the invoice (`parentType:
  providerinvoice`, lowercase as in the RAML; `providerInvoice` is a 422) and
  read back intact. Findings from that run:
  - A shared drive that restricts download / copy (`copyRequiresWriterPermission`
    or the newer download restrictions) makes `alt=media` answer 403 "This file
    cannot be downloaded by the user" even for the service account: the
    shared drive must allow downloads.
  - The tag search (`files.list` + `appProperties`) lagged behind fresh
    uploads: two refused claims purged nothing and raised nothing, leaving
    their files. `purge(ref, stored)` now deletes by the id `stat` found
    first, then by search; a failed purge in `claim` is logged and named in
    the refusal (it used to be swallowed there too).
  - The stale-sweep cutoff with milliseconds (`…:00.000Z`) made `files.list`
    return nothing, without error; the cutoff is now sent as `…:00Z`.
  - Without the Manager role on the **shared drive itself**, `files.delete`
    answered 404 for files the account could list and read, and the 404 was
    taken as "already gone": nothing was deleted, nothing reported. A 404 is
    now checked with a `files.get`; a file still there goes to the trash
    fallback below. With the role granted, the stale sweep (corrected cutoff)
    found the 4 leftover test files and deleted them: 4 × 204, folder and
    trash empty (observed).
  Further design notes:
  - **No pre-authenticated download URL exists** (downloads need a token;
    `webContentLink` implies link sharing, which Workspace policy may block).
    So `StoredObject.downloadUrl` is optional, the backend implements `read`,
    and `ClaimedUpload` carries `data` instead: `boond_documents_create` sends
    the bytes as the multipart `file` part (the path `filePath` uses), not a
    `fileUrl`. The size cap is re-checked on the bytes read.
  - The transit folder must sit in a **shared drive** (`driveId` checked on
    first use; a service account has no My Drive storage). Every call passes
    `supportsAllDrives`; the listing uses `corpora=drive` + `driveId`.
  - Slot = resumable upload session (`uploadType=resumable`, `Location` header
    = `uploadUrl`) whose metadata tags the file with `appProperties.boondMcpSlot`;
    `stat` / `purge` find it by that tag (the file id exists only once the
    upload completes). One PUT of the whole file, without a token, was
    observed working (see above).
  - Purge is `files.delete`, permanent (no trash), which needs `organizer` on
    the shared drive. When it is refused (403, or a 404 on a file still
    there), the file is moved to the trash (`PATCH trashed: true`, emptied by
    Drive after 30 days) with a `warn` log, and `purge` returns `trashed` so
    `boond_documents_create` says so in its result: better a file in the bin
    than one left in the transit folder. Both refused → error. The fallback
    has **not** been exercised on a real Workspace.
  - A Drive resumable session outlives the 15-min slot (its URI stays valid
    far longer), so a late PUT, or a restart that lost the in-memory slots,
    can leave a tagged file no slot will purge. `RelayBackend.sweepStale`
    (optional) runs on every `open`: Drive deletes every file of the
    dedicated transit folder created before now − TTL. Searches are confined
    to the transit folder (`'<folder>' in parents`).
  - A failed purge is never hidden: it is logged; when the upload to Boond
    succeeded, `boond_documents_create` also says "copie de transit NON
    supprimée" in its result, and a claim refusal names it (both used to
    swallow it). When Boond itself failed, the log is the only trace.
- Relay backends call `fetch` directly, not `send()`: `send()` is the
  BoondManager client (Boond auth, path guard, rate bucket, `X-Request-Id`),
  wrong for a third-party store. The cost: no request cancellation and no
  retry on the store's 429 / 5xx.
