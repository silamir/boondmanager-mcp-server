// Conventional Commits configuration
// Docs: https://commitlint.js.org
//
// Extension .cjs volontaire : ce fichier utilise la syntaxe CommonJS
// (module.exports). En .js, il casserait dès qu'un projet ajoute
// "type": "module" a son package.json. Pour passer en ESM, renommer en
// commitlint.config.mjs et remplacer module.exports par export default.
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",     // new feature
        "fix",      // bug fix
        "docs",     // documentation only
        "style",    // formatting, no code change
        "refactor", // code change that isn't a feature or fix
        "perf",     // performance improvement
        "test",     // adding/updating tests
        "build",    // build system or external dependencies
        "ci",       // CI configuration
        "chore",    // other changes that don't modify src or tests
        "revert",   // revert a previous commit
      ],
    ],
    "subject-case": [2, "never", ["upper-case", "pascal-case", "start-case"]],
    "subject-empty": [2, "never"],
    "subject-full-stop": [2, "never", "."],
    "header-max-length": [2, "always", 100],
    "body-leading-blank": [1, "always"],
    "footer-leading-blank": [1, "always"],
  },
};
