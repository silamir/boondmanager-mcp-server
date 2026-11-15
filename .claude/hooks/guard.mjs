#!/usr/bin/env node
// PreToolUse guard for the rules of this repository that admit no exception.
// Exit code 2 blocks the tool call; stderr is handed back to Claude as the reason.
//
// - `git add -A` / `--all` / `.` once published untracked CRM extracts in a PR
//   (PR #284): the working tree carries scratch dirs `.gitignore` does not cover.
// - TOOLS.md and the plugin files are generated; a hand edit is overwritten by the
//   generator and fails the CI drift check.
import { readFileSync } from "node:fs";

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const tool = input.tool_name;
const args = input.tool_input ?? {};

function block(reason) {
  process.stderr.write(reason + "\n");
  process.exit(2);
}

if (tool === "Bash" && typeof args.command === "string") {
  // Split on shell separators so `git status && git add .` is caught too.
  for (const part of args.command.split(/&&|\|\||;|\n/)) {
    const words = part.trim().split(/\s+/);
    const i = words.indexOf("add");
    if (words[0] !== "git" || i < 1) continue;
    const rest = words.slice(i + 1);
    if (rest.some((w) => w === "-A" || w === "--all" || w === "." || w === ":/" || /^-[a-zA-Z]*A/.test(w))) {
      block(
        "Blocked: stage by explicit path in this repository (e.g. `git add src CHANGELOG.md TOOLS.md`). " +
          "`git add -A` / `git add .` once committed untracked CRM data. Check `git status --short` first."
      );
    }
  }
}

if ((tool === "Edit" || tool === "Write" || tool === "MultiEdit") && typeof args.file_path === "string") {
  const p = args.file_path.replaceAll("\\", "/");
  if (/(^|\/)TOOLS\.md$/.test(p)) {
    block("Blocked: TOOLS.md is generated. Run `npm run docs:tools` instead of editing it.");
  }
  if (/(^|\/)plugins\/boondmanager-mcp\//.test(p)) {
    block(
      "Blocked: plugins/boondmanager-mcp/ is generated from manifest.json. " +
        "Edit manifest.json (or scripts/generate-plugin-manifest.mjs) and run `npm run plugin:manifest`."
    );
  }
}

process.exit(0);
