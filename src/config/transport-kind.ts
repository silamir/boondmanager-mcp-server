import { readString } from "./env.js";

export type TransportKind = "stdio" | "http";

/**
 * The transport selected by `MCP_TRANSPORT`. Lives in `config/` rather than
 * `index.ts` so that tools whose behaviour depends on where the server runs
 * (local-file uploads are stdio-only) read the same rule the entry point does.
 */
export function resolveTransport(env: NodeJS.ProcessEnv = process.env): TransportKind {
  const raw = (readString("MCP_TRANSPORT", env) ?? "").toLowerCase().trim();
  if (raw === "http" || raw === "streamable-http" || raw === "streamablehttp") return "http";
  return "stdio";
}
