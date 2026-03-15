/**
 * Patches @coral-xyz/anchor + @meteora-ag/dlmm for Node 24 ESM compatibility.
 *
 * Problem: Node 24 ESM doesn't support bare directory imports (e.g. "utils/bytes").
 * DLMM's index.mjs does: import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes"
 * ESM never extension-guesses, so it hits the bytes/ directory and throws.
 *
 * Fix 1: Add an exports map to anchor's package.json mapping each util dir to its index.js.
 * Fix 2: Directly rewrite the bare import in DLMM's index.mjs to use the explicit path.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

// ─── Fix 1: Patch anchor's package.json exports ──────────────────────────────
const anchorPkgPath = path.join(root, "node_modules/@coral-xyz/anchor/package.json");
const anchorPkg = JSON.parse(fs.readFileSync(anchorPkgPath, "utf8"));
const anchorUtils = path.join(root, "node_modules/@coral-xyz/anchor/dist/cjs/utils");

if (!anchorPkg.exports) {
  const dirs = fs.readdirSync(anchorUtils, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  anchorPkg.exports = {
    // Always serve CJS — anchor's ESM dist has its own bare directory import bugs
    ".": {
      default: "./dist/cjs/index.js",
    },
    // Map each util directory to its explicit CJS index.js
    ...Object.fromEntries(
      dirs.map(dir => [
        `./dist/cjs/utils/${dir}`,
        `./dist/cjs/utils/${dir}/index.js`,
      ])
    ),
    // Allow any other direct file path through
    "./*": "./*",
  };

  fs.writeFileSync(anchorPkgPath, JSON.stringify(anchorPkg, null, 2));
  console.log("Patched: @coral-xyz/anchor/package.json exports");
} else {
  console.log("Skip: @coral-xyz/anchor exports already set");
}

// ─── Fix 2: Patch DLMM index.mjs bare directory imports ──────────────────────
const dlmmMjs = path.join(root, "node_modules/@meteora-ag/dlmm/dist/index.mjs");

if (fs.existsSync(dlmmMjs)) {
  let src = fs.readFileSync(dlmmMjs, "utf8");
  const original = src;

  // Replace all bare directory imports of anchor utils with explicit .js paths
  src = src.replace(
    /from ["'](@coral-xyz\/anchor\/dist\/cjs\/utils\/\w+)["']/g,
    (_, p) => `from "${p}/index.js"`
  );

  if (src !== original) {
    fs.writeFileSync(dlmmMjs, src);
    console.log("Patched: @meteora-ag/dlmm/dist/index.mjs directory imports");
  } else {
    console.log("Skip: @meteora-ag/dlmm/dist/index.mjs already patched");
  }
}
