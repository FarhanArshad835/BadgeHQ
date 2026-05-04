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

const __dirname = dirname(fileURLToPath(import.meta.url));
const widgetPath = resolve(__dirname, "..", "public", "widget.js");
const outPath = resolve(__dirname, "src", "widget-source.generated.js");

const source = readFileSync(widgetPath, "utf8");
const stat = statSync(widgetPath);
const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
const builtAt = new Date().toISOString();

const out = `// AUTO-GENERATED — do not edit.
// Source: public/widget.js  bytes=${source.length}  hash=${hash}  built=${builtAt}
export const WIDGET_SOURCE = ${JSON.stringify(source)};
export const WIDGET_HASH = ${JSON.stringify(hash)};
export const WIDGET_BUILT_AT = ${JSON.stringify(builtAt)};
`;

writeFileSync(outPath, out, "utf8");
console.log(`[build] embedded ${source.length} bytes from ${widgetPath}`);
console.log(`[build] hash=${hash}  modified=${stat.mtime.toISOString()}`);
console.log(`[build] -> ${outPath}`);
