// Pre-build step: read /public/widget.js from the parent repo and emit
// src/widget-source.generated.js that exports it as a string. The worker
// then imports and returns it as the response body. Bundled at deploy
// time so the worker doesn't have to fetch widget.js from anywhere.
//
// Run via `npm run build` (also invoked automatically by `npm run deploy`).

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const widgetPath = resolve(__dirname, "..", "public", "widget.js");
const outPath = resolve(__dirname, "src", "widget-source.generated.js");

const source = readFileSync(widgetPath, "utf8");
// The grid-only bundle, built first by build-grid.js. Optional: a checkout
// that has not run it yet still deploys a working widget, just without the
// fast path.
let gridSource = "";
try {
  gridSource = readFileSync(resolve(__dirname, "..", "public", "grid.js"), "utf8");
} catch {
  gridSource = "";
}
const stat = statSync(widgetPath);
const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
const builtAt = new Date().toISOString();

// Compressed here, at maximum effort, instead of leaving it to the edge.
//
// Cloudflare compresses on the fly at a fast, low setting: the served file
// was measured at 119KB where the same bytes at brotli quality 11 are 97KB.
// A build runs once; a shopper downloads the result every time the cache
// misses, so the expensive setting belongs here.
//
// Base64 because the generated file is a JS module: it costs a third more
// in the bundle, which is deploy-time only, and decodes to the exact bytes.
const brotli = brotliCompressSync(Buffer.from(source, "utf8"), {
  params: {
    [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
    [zlibConstants.BROTLI_PARAM_SIZE_HINT]: source.length,
  },
});
const brotliB64 = brotli.toString("base64");

const out = `// AUTO-GENERATED — do not edit.
// Source: public/widget.js  bytes=${source.length}  hash=${hash}  built=${builtAt}
export const WIDGET_SOURCE = ${JSON.stringify(source)};
export const WIDGET_HASH = ${JSON.stringify(hash)};
export const WIDGET_BUILT_AT = ${JSON.stringify(builtAt)};
/** The same source, brotli quality 11, base64-encoded. Served as-is to any
 *  client that accepts br, so the edge never has to compress it. */
export const WIDGET_BROTLI_B64 = ${JSON.stringify(brotliB64)};
/** The grid-only bundle served at /grid.js, and its own hash for ETag use. */
export const GRID_SOURCE = ${JSON.stringify(gridSource)};
export const GRID_HASH = ${JSON.stringify(
  gridSource ? createHash("sha256").update(gridSource).digest("hex").slice(0, 12) : "",
)};
`;

writeFileSync(outPath, out, "utf8");
console.log(`[build] embedded ${source.length} bytes from ${widgetPath}`);
console.log(
  `[build] brotli-11 ${brotli.length} bytes (${(100 * brotli.length / source.length).toFixed(1)}% of raw)`,
);
console.log(`[build] hash=${hash}  modified=${stat.mtime.toISOString()}`);
console.log(`[build] -> ${outPath}`);
