// Bundles the CLI (for npm) and the GitHub Action (committed, since an action has no install
// step) into single files. Workspace packages are TypeScript source: npm users and Actions
// runners need plain JavaScript with every dependency inside.

import { build } from "esbuild";

// Some bundled dependencies (TypeScript, inside ts-morph) are CommonJS and use require,
// __filename and __dirname, which do not exist in an ES module. Recreate them.
const shims = [
  'import { createRequire as __createRequire } from "node:module";',
  'import { fileURLToPath as __fileURLToPath } from "node:url";',
  'import { dirname as __pathDirname } from "node:path";',
  "const require = __createRequire(import.meta.url);",
  "const __filename = __fileURLToPath(import.meta.url);",
  "const __dirname = __pathDirname(__filename);",
].join("\n");

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  // Licences of the bundled packages travel with the code, as their licences require.
  legalComments: "eof",
  logLevel: "warning",
} as const;

await build({
  ...common,
  entryPoints: [new URL("src/cli.ts", import.meta.url).pathname],
  outfile: new URL("dist/cli.js", import.meta.url).pathname,
  banner: { js: `#!/usr/bin/env node\n${shims}` },
});

await build({
  ...common,
  entryPoints: [new URL("src/action.ts", import.meta.url).pathname],
  outfile: new URL("../../action/dist/index.js", import.meta.url).pathname,
  banner: { js: shims },
});

console.log("Built packages/cli/dist/cli.js and action/dist/index.js");
