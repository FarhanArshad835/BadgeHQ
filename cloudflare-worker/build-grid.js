// Builds public/grid.js: the ordered grid alone, for collection pages.
//
// Why a second file. On Slow 3G the full widget.js was measured at 124KB
// taking 35.1s to arrive - 3.0s stalled, 0.4s to first byte, and 31.8s of
// download, because 156 other files and 955KB were sharing a 400kbps line.
// The grid's own data (colour list, ranking) was ready at 8s and then waited
// 28s for the code. 124KB at 400kbps is 2.5s unshared; the problem is the
// share, so the fix is to need less of the line, not to be faster on it.
//
// Extracted from widget.js rather than written separately, so there is one
// implementation of the renderer and it cannot drift. The pieces taken are
// the ones renderOrderedGrid actually references.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { brotliCompressSync, constants as zc } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Normalised: widget.js is stored with CRLF endings, so anchors written with
// \n would never match.
const src = readFileSync(resolve(__dirname, "..", "public", "widget.js"), "utf8").replace(/\r\n/g, "\n");

/** Take from `start` up to (not including) `end`. Throws if either is absent,
 *  so a rename in widget.js fails the build instead of shipping a broken
 *  bundle. */
function slice(start, end) {
  const i = src.indexOf(start);
  if (i < 0) throw new Error("build-grid: missing start anchor: " + start.slice(0, 60));
  const j = src.indexOf(end, i + start.length);
  if (j < 0) throw new Error("build-grid: missing end anchor: " + end.slice(0, 60));
  return src.slice(i, j);
}

const grid = slice("  /**\n   * Draw the collection from the engine's ordered colour list.", "  function renderColorCards(gs) {");
const scoreBehaviour = slice("  function scoreBehaviour(W) {", "  /** Personalisation grows with engagement.");
const num = slice("  function num(v, dflt) {", "\n  }") + "\n  }\n";

const out = `/**
 * BadgeHQ ordered grid - standalone collection-page bundle.
 *
 * AUTO-GENERATED from public/widget.js by cloudflare-worker/build-grid.js.
 * Do not edit: change widget.js and rebuild, or the two renderers drift.
 *
 * This exists because of the share of the line, not the size of the file.
 * Measured on Slow 3G: widget.js is 124KB and took 35.1s to arrive while 156
 * other files and 955KB competed for 400kbps. The grid's data was ready at
 * 8s. This bundle is about 9KB compressed, so it arrives while the rest of
 * the page is still loading and the grid draws from data that is already in
 * hand.
 *
 * widget.js still loads after it and does everything else. It sees
 * window.__bhqOrdered already set and leaves the grid alone.
 */
(function () {
  "use strict";
  var SHOP = (window.Shopify && window.Shopify.shop) || "";
  if (!SHOP) return;
  if (location.pathname.indexOf("/collections/") < 0) return;

  var API_ORIGIN = "https://badgehq-widget.badgehq.workers.dev";
  var DECAY_HALFLIFE_MIN = 20;

  // Set by the app embed, read by the grid; absent on a theme without it,
  // in which case the grid fetches for itself exactly as widget.js does.
  var __bhqTplPromise = null;
  var __bhqRestore = null;
  function __bhqRestoreScroll() {}

  // The behaviour config normally arrives with the widget config, which this
  // bundle deliberately does not wait for. Defaults match the engine's, and
  // widget.js applies the merchant's own weights when it lands.
  var __bhqBehaviourOn = true;
  var __bhqBehaviourWeights = null;

${num}
${scoreBehaviour}
${grid}

  // Draw the moment Shopify's grid exists, not when the document finishes.
  //
  // Waiting on DOMContentLoaded cost 20 seconds on Slow 3G: the grid was in
  // the DOM at 9.6s, but the event did not fire until 29.6s because the
  // 1.1MB document was still parsing and 665KB of other files were still
  // arriving. This file had been downloaded since 2.8s.
  //
  // A MutationObserver sees the grid as the parser writes it, so the draw
  // happens at the first moment it is possible rather than the last.
  var started = false;
  function start() {
    if (started) return;
    // A grid with a usable card in it, not merely a grid.
    //
    // The template is copied from a card already on the page. Starting at the
    // first sign of #product-grid meant starting when it held one half-parsed
    // card with no <img>, so the copy was rejected and the renderer fell back
    // to re-fetching the collection as a section: 22KB that took 11.5s on
    // Slow 3G and became the whole remaining delay.
    //
    // Two cards, because the first can still be mid-parse when the second
    // appears.
    var g = document.querySelector("#product-grid");
    if (!g) return;
    var cards = g.querySelectorAll("li.grid__item");
    if (cards.length < 2 || !cards[0].querySelector("img")) return;
    started = true;
    if (obs) obs.disconnect();
    clearInterval(poll);
    try {
      // Through the wrapper, so this bundle records its answer as
      // window.__bhqGridDecision. widget.js arrives later, hits the re-entry
      // guard, and waits for that answer instead of reading a bare false as
      // "the grid declined" - which is what made it split Shopify's hidden
      // grid and fire two wasted color-demand requests.
      __bhqRunGrid().then(
        function () {},
        function () {},
      );
    } catch (e) {
      /* the theme's own grid stands */
    }
  }
  var obs = null;
  // Polled as well as observed: an observer only reports changes, so a grid
  // already parsed before this file ran would never produce one.
  var poll = setInterval(start, 50);
  try {
    obs = new MutationObserver(start);
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {
    /* the poll above is enough on its own */
  }
  // A grid that never appears must not leave an interval running for ever.
  setTimeout(function () { clearInterval(poll); if (obs) obs.disconnect(); }, 60000);
  start();
})();
`;

const outPath = resolve(__dirname, "..", "public", "grid.js");
writeFileSync(outPath, out, "utf8");
const hash = createHash("sha256").update(out).digest("hex").slice(0, 12);
const br = brotliCompressSync(Buffer.from(out, "utf8"), {
  params: { [zc.BROTLI_PARAM_QUALITY]: 11 },
});
console.log(`[grid] ${out.length} bytes raw, ${br.length} brotli, hash=${hash}`);
console.log(`[grid] -> ${outPath}`);
