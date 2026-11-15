#!/bin/sh
# Stop hook: Claude cannot end its turn while TypeScript sources it changed
# do not typecheck. Exit 2 sends the compiler output back as the reason.
# Skipped when nothing under src/ differs from HEAD (questions, docs-only turns).
cd "$CLAUDE_PROJECT_DIR" || exit 0
[ -z "$(git status --porcelain -- src 2>/dev/null)" ] && exit 0
[ -d node_modules ] || exit 0
npx --no-install tsc --noEmit 1>&2 || exit 2
