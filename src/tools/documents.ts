import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiDownload, apiUploadForm, formatDetailResponse, DownloadTooLargeError } from "../services/boond-client.js";
import { progressReporterFrom } from "../services/progress.js";
import { z } from "zod";
import { DocumentGetSchema, DocumentCreateSchema, DocumentUploadSlotSchema } from "../schemas/index.js";
import type { DocumentGetInput, DocumentCreateInput, DocumentUploadSlotInput } from "../schemas/index.js";
import { uploadRelay } from "../services/upload-relay.js";
import type { ClaimedUpload } from "../services/upload-relay.js";
import { MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES, CHARACTER_LIMIT, INLINE_UPLOAD_MAX_BYTES } from "../constants.js";
import { decodeInlineUpload, readLocalUpload, UploadRejectedError } from "../services/upload-source.js";
import type { UploadFile } from "../services/upload-source.js";
import { registerDeleteTool, MutationOutputSchema } from "./crud-factory.js";
import { extractDocxText, extractPdfText, isDocxMime, isImageMime, isPdfMime } from "../services/document-text.js";
import type { ExtractedText } from "../services/document-text.js";

/** Mime types rendered as plain text instead of a base64 blob. */
function isTextMime(mime: string): boolean {
  return mime.startsWith("text/") || /[+/](json|xml)$|^application\/(json|xml|csv)$/.test(mime);
}

const UploadSlotOutputSchema = z.object({
  uploadSlot: z.string(),
  uploadUrl: z.string(),
  expiresAt: z.string(),
  maxBytes: z.number(),
  fileName: z.string(),
  uploadCommand: z.string(),
});

export function registerDocumentTools(server: McpServer): void {
  // Download a document (CV, justificatif, contrat...)
  server.registerTool(
    "boond_documents_get",
    {
      title: "Télécharger un document",
      description: `Télécharge un document BoondManager (CV de candidat/ressource, justificatif, contrat, facture...) par son ID, et le rend lisible : texte extrait pour un PDF ou un DOCX, contenu \`image\` (visible par le modèle) pour une image, texte brut pour un fichier texte.

Où trouver les IDs de documents : dans les onglets des entités — ex. boond_candidates_information expose les relations 'resumes' (CV) et 'files' (dossier administratif). ⚠️ Reprendre l'ID **tel quel**, suffixe compris (ex. '123_resume') : un ID tronqué à sa partie numérique ne désigne aucun document.

\`mode: "text"\` (défaut) : PDF / DOCX → texte extrait côté serveur (borné à ${CHARACTER_LIMIT} caractères, taille et nombre de pages d'origine indiqués) ; image PNG / JPEG / GIF / WebP → contenu \`image\` jusqu'à ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} Mo. Un PDF scanné ou chiffré, dont rien ne s'extrait, est renvoyé tel quel avec un avertissement. \`mode: "raw"\` : le fichier tel quel en ressource embarquée (base64) — coûteux en contexte, à réserver aux cas où les octets sont nécessaires (transfert, format non géré). Taille max téléchargée : ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)} Mo.

Returns : texte extrait, contenu \`image\`, ou ressource embarquée (\`blob\` base64) selon le format et le mode.
Un ID inconnu est rejeté explicitement plutôt que de renvoyer la page d'accueil BoondManager, que l'API sert en HTTP 200 à la place d'un 404.`,
      inputSchema: DocumentGetSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: DocumentGetInput, extra: unknown) => {
      // Byte-level progress, but only when the client asked for it and the
      // response announces a Content-Length (see readDownloadBody). The size
      // cap is enforced *during* the download (#235): an announced size over
      // the cap is refused before the body is read, an unannounced one is cut
      // the moment it crosses it — never buffered whole and then refused.
      let doc;
      try {
        doc = await apiDownload(`/documents/${params.id}`, progressReporterFrom(extra), {
          maxBytes: MAX_DOCUMENT_BYTES,
        });
      } catch (err) {
        if (!(err instanceof DownloadTooLargeError)) throw err;
        const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
        const size = err.announced ? `${mb(err.bytes)} Mo` : `plus de ${mb(err.bytes)} Mo`;
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `❌ Document #${params.id} trop volumineux pour être retourné inline: ${size} (max ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)} Mo). Le téléchargement a été interrompu sans charger le fichier en mémoire.`,
            },
          ],
        };
      }
      const uri = `boond://documents/${params.id}`;
      const name = doc.filename ?? `document-${params.id}`;
      const sizeKb = (doc.data.length / 1024).toFixed(0);
      const header = `Document #${params.id} — ${name} (${doc.contentType}, ${sizeKb} Ko)`;

      if (isTextMime(doc.contentType)) {
        let text = doc.data.toString("utf8");
        if (text.length > CHARACTER_LIMIT) {
          text = text.substring(0, CHARACTER_LIMIT) + "\n\n[Contenu tronqué...]";
        }
        return {
          content: [
            { type: "text" as const, text: `Document #${params.id} — ${name} (${doc.contentType})\n\n${text}` },
          ],
        };
      }

      const raw = (note?: string) => ({
        content: [
          {
            type: "text" as const,
            text: `${header}, contenu joint en ressource embarquée.${note ? `\n${note}` : ""}`,
          },
          {
            type: "resource" as const,
            resource: { uri, mimeType: doc.contentType, blob: doc.data.toString("base64") },
          },
        ],
      });

      if (params.mode === "raw") return raw();

      // Issue #263 — an image is handed to the model as `image` content, the
      // only shape hosts reliably pass to its vision input; a blob is opaque.
      if (isImageMime(doc.contentType)) {
        if (doc.data.length > MAX_IMAGE_BYTES) {
          return raw(
            `⚠️ Image de ${sizeKb} Ko, au-delà des ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} Mo affichables en contenu \`image\` : renvoyée en ressource embarquée.`
          );
        }
        return {
          content: [
            { type: "text" as const, text: `${header} — image jointe.` },
            { type: "image" as const, data: doc.data.toString("base64"), mimeType: doc.contentType },
          ],
        };
      }

      // Issue #263 — a 5 MiB PDF is ~6.6 MB of base64 for a few KB of text.
      if (isPdfMime(doc.contentType) || isDocxMime(doc.contentType, doc.filename, doc.data)) {
        let extracted: ExtractedText;
        try {
          extracted = isPdfMime(doc.contentType) ? await extractPdfText(doc.data) : extractDocxText(doc.data);
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          return raw(`⚠️ Extraction du texte impossible (${why}) : fichier renvoyé tel quel.`);
        }
        const truncated = extracted.text.length > CHARACTER_LIMIT;
        const text = truncated ? extracted.text.substring(0, CHARACTER_LIMIT) : extracted.text;
        const pages = extracted.pages !== undefined ? `, ${extracted.pages} page(s)` : "";
        const cut = truncated
          ? `\n\n[Texte tronqué à ${CHARACTER_LIMIT} caractères sur ${extracted.text.length} — \`mode: "raw"\` pour le fichier complet.]`
          : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Document #${params.id} — ${name} (${doc.contentType}, ${sizeKb} Ko${pages}) — texte extrait :\n\n${text}${cut}`,
            },
          ],
        };
      }

      return raw();
    }
  );

  // Open a single-use upload slot on the operator's relay (chat attachments)
  server.registerTool(
    "boond_documents_upload_slot",
    {
      title: "Ouvrir un slot d'upload",
      description: `Ouvre un slot d'upload à usage unique sur le relais de stockage configuré par l'opérateur (\`BOOND_MCP_UPLOAD_RELAY\`, ex. SharePoint), pour transmettre à BoondManager un fichier qui n'est ni à une URL publique ni sur le poste du serveur — typiquement une pièce jointe de conversation, présente dans l'environnement d'exécution de code du client.

Déroulé : (1) appeler cet outil avec le nom du fichier ; (2) déposer le fichier sur \`uploadUrl\` en **une seule requête PUT** depuis l'environnement d'exécution, avec la commande \`curl\` renvoyée — les octets ne passent pas par la réponse du modèle ; (3) appeler \`boond_documents_create\` avec \`uploadSlot\`. Le fichier est vérifié (taille, premiers octets), transmis à Boond par une URL de lecture temporaire, puis supprimé définitivement du relais.

Slot valable 15 min, un seul fichier, un seul usage. \`uploadUrl\` est pré-authentifiée : ne pas la réutiliser ni la partager.

Returns: \`uploadSlot\`, \`uploadUrl\`, \`expiresAt\`, \`maxBytes\`, \`fileName\` et la commande d'upload.`,
      inputSchema: DocumentUploadSlotSchema,
      outputSchema: UploadSlotOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: DocumentUploadSlotInput) => {
      let slot;
      try {
        slot = await uploadRelay.open(params.fileName);
      } catch (error) {
        if (error instanceof UploadRejectedError) {
          return { isError: true, content: [{ type: "text" as const, text: `❌ ${error.message}` }] };
        }
        throw error;
      }
      const command =
        `F="<chemin-du-fichier>"; N=$(stat -c%s "$F"); ` +
        `curl -sS --fail-with-body -X PUT -H "Content-Length: $N" -H "Content-Range: bytes 0-$((N-1))/$N" ` +
        `--data-binary @"$F" "${slot.uploadUrl}"`;
      return {
        content: [
          {
            type: "text" as const,
            text:
              `✅ Slot d'upload ouvert (expire ${slot.expiresAt}, ${(slot.maxBytes / 1024 / 1024).toFixed(0)} Mo max).\n` +
              `uploadSlot: ${slot.uploadSlot}\n\n` +
              `Déposer le fichier depuis l'environnement d'exécution (remplacer <chemin-du-fichier>) :\n${command}\n\n` +
              `Puis : boond_documents_create({ parentType, parentId, uploadSlot: "${slot.uploadSlot}" }).`,
          },
        ],
        structuredContent: {
          uploadSlot: slot.uploadSlot,
          uploadUrl: slot.uploadUrl,
          expiresAt: slot.expiresAt,
          maxBytes: slot.maxBytes,
          fileName: slot.filename,
          uploadCommand: command,
        },
      };
    }
  );

  // Upload a document: by URL, local path (opt-in, stdio), inline base64 or relay slot
  server.registerTool(
    "boond_documents_create",
    {
      title: "Téléverser un document",
      description: `Attache un document à une entité BoondManager. Exactement une source par appel :
- \`fileUrl\` : URL https que BoondManager télécharge lui-même ;
- \`filePath\` : chemin absolu d'un fichier local, lu par le serveur MCP — transport stdio uniquement, sous un répertoire de \`BOOND_MCP_UPLOAD_DIRS\` (désactivé par défaut) ;
- \`uploadSlot\` : fichier déposé sur un slot de \`boond_documents_upload_slot\` — **la voie pour une pièce jointe de conversation** ;
- \`fileContent\` (base64) + \`fileName\` : petit fichier inline, ${Math.round(INLINE_UPLOAD_MAX_BYTES / 1024 / 1024)} Mo max, réservé à un appelant qui détient déjà les octets exacts (un modèle ne retranscrit pas fiablement une pièce jointe en base64).

Le format est vérifié sur les premiers octets du fichier (PDF, Office, ODF, RTF, images), pas sur l'extension. Cas d'usage typiques : CV d'un candidat (parentType=candidateResume, parsing=true pour l'analyse IA Boond), pièce jointe d'un besoin / AO (parentType=opportunity), d'un positionnement (positioning), justificatif de note de frais (expensesReport), bon de commande, contrat...

\`parentType\` n'est pas limité à une liste fermée : il est transmis tel quel à BoondManager, qui valide le type. Un type que l'API ne gère pas est refusé sans rien écrire.

Returns: Métadonnées du document créé (ID).`,
      inputSchema: DocumentCreateSchema,
      outputSchema: MutationOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params: DocumentCreateInput) => {
      const reject = (text: string) => ({ isError: true, content: [{ type: "text" as const, text: `❌ ${text}` }] });

      const sources = [params.fileUrl, params.filePath, params.fileContent, params.uploadSlot].filter(
        (v) => v !== undefined
      ).length;
      if (sources !== 1) {
        return reject(
          `Exactement une source de fichier est attendue (reçu : ${sources}). Fournir \`fileUrl\`, \`filePath\`, ` +
            "`uploadSlot`, ou `fileContent` + `fileName`."
        );
      }
      if (params.fileContent !== undefined && params.fileName === undefined) {
        return reject("`fileName` (avec extension, ex. « cv.pdf ») est requis avec `fileContent`.");
      }
      if (params.fileContent === undefined && params.fileName !== undefined) {
        return reject("`fileName` ne s'utilise qu'avec `fileContent`.");
      }

      let file: UploadFile | undefined;
      let relayed: ClaimedUpload | undefined;
      try {
        if (params.filePath !== undefined) file = await readLocalUpload(params.filePath);
        else if (params.fileContent !== undefined && params.fileName !== undefined)
          file = decodeInlineUpload(params.fileContent, params.fileName);
        else if (params.uploadSlot !== undefined) relayed = await uploadRelay.claim(params.uploadSlot);
      } catch (error) {
        if (error instanceof UploadRejectedError) return reject(error.message);
        throw error;
      }

      const fields: Record<string, string> = {
        parentType: params.parentType,
        parentId: String(params.parentId),
      };
      if (params.fileUrl !== undefined) fields.fileUrl = params.fileUrl;
      // The relay hands Boond a short-lived pre-authenticated download URL.
      if (relayed !== undefined) fields.fileUrl = relayed.downloadUrl;
      if (params.parsing !== undefined) fields.parsing = String(params.parsing);

      let response;
      try {
        response =
          file === undefined
            ? await apiUploadForm("/documents", fields)
            : await apiUploadForm("/documents", fields, file);
      } finally {
        // Boond has fetched the file (or failed): purge the relay copy either way.
        if (relayed !== undefined) await relayed.release().catch(() => undefined);
      }
      const entity = Array.isArray(response.data) ? response.data[0] : response.data;
      const structured: { id?: string; type?: string } = {};
      if (entity?.id !== undefined) structured.id = String(entity.id);
      if (entity?.type !== undefined) structured.type = String(entity.type);
      const sent =
        file !== undefined
          ? `\nFichier: ${file.filename} (${file.contentType}, ${(file.data.length / 1024).toFixed(0)} Ko)`
          : relayed !== undefined
            ? `\nFichier: ${relayed.filename} (${relayed.contentType}, ${(relayed.size / 1024).toFixed(0)} Ko, via relais — copie de transit supprimée)`
            : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Document créé avec succès.\nID: ${entity?.id}${sent}\n\n${formatDetailResponse(response)}`,
          },
        ],
        structuredContent: structured,
      };
    }
  );

  // Delete a document — factory: élicitation de confirmation + structuredContent
  registerDeleteTool(
    server,
    { entityName: "document", entityNamePlural: "documents", apiPath: "/documents", prefix: "boond_documents" },
    {
      title: "Supprimer un document",
      description: `Supprime définitivement un document (CV, justificatif, pièce jointe) de BoondManager.

⚠️ Irréversible, sans corbeille côté API. Si le client MCP annonce la capacité \`elicitation\`, une confirmation est demandée à l'utilisateur final et un refus annule l'appel.

Returns : \`{ id, deleted, reason? }\` — vérifier \`deleted\`, qui vaut \`false\` en cas de refus utilisateur.`,
    }
  );
}
