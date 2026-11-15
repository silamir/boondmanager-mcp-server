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
`boond_documents_create` uploads **by URL only** (`fileUrl` — Boond fetches
the file server-side; the MCP server never reads local files), with
`parsing: true` to trigger Boond's AI resume parsing on `candidateResume`.
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
  swept when a new one opens; a crash leaves `mcp-<uuid>` folders to clean by
  hand.
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
