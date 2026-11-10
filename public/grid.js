/**
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

  function num(v, dflt) {
    var n = Number(v);
    return isFinite(n) && n >= 0 ? n : dflt;
  }

  function scoreBehaviour(W) {
    var bag = {};
    try {
      bag = JSON.parse(sessionStorage.getItem("badgehq-behaviour") || "{}") || {};
    } catch (e) {
      return [];
    }
    var now = Date.now();
    var out = [];
    for (var k in bag) {
      var b = bag[k];
      if (!b || !b.h) continue;
      // Each component floors at zero independently. Without the floor a
      // removal drags the whole score negative and a product with real cart
      // interest could rank below one with none. Caps are twice the unit
      // value, so a second action still counts and a tenth does not.
      var cart = Math.max(Math.min((b.ca || 0) * W.cart, W.cart * 2) - (b.cr || 0) * Math.round(W.cart * 0.75), 0);
      var wish = Math.max(Math.min((b.wa || 0) * W.wish, W.wish * 2) - (b.wr || 0) * Math.round(W.wish * 0.9), 0);
      var views = Math.min(b.v || 0, 4) * W.views;
      var sc = cart + wish + ((b.d || 0) > 0 ? W.dwell : 0) + views;
      if (sc <= 0) continue;
      // Recency. Without it every engagement carries equal weight, so a
      // shopper with ten wishlists has ten products worth exactly the same
      // and no ordering at all among their own interests.
      var ageMin = b.t ? (now - b.t) / 60000 : 0;
      var decay = ageMin > 0 ? Math.pow(0.5, ageMin / DECAY_HALFLIFE_MIN) : 1;
      if (decay < 0.25) decay = 0.25;
      out.push({ handle: b.h, score: sc * decay, seen: b.t || 0 });
    }
    out.sort(function (a, b2) {
      if (b2.score !== a.score) return b2.score - a.score;
      return b2.seen - a.seen;
    });
    return out;
  }


  /**
   * Draw the collection from the engine's ordered colour list.
   *
   * Copied from public/experimental/ordered-grid.js, which stays as the
   * standalone version that can be pasted into DevTools on a live page. The
   * code below is that file's, unchanged except that the shop and API base
   * come from the page instead of constants, and every exit returns true or
   * false so renderColorCards can fall back to splitting Shopify's own grid.
   *
   * Why it exists: the split rearranges the 24 products Shopify happened to
   * send, so a colour belonging on page 5 sits on page 1 until a later batch
   * displaces it - measured at 42 of 73 cards moving after one scroll. This
   * draws from a list built across the whole collection, so a card is placed
   * once, in its final position, and never moves.
   *
   * Returns true when it has taken over the grid, false when it touched
   * nothing at all.
   */
  async function renderOrderedGrid() {
  'use strict';
  if (window.__bhqOrdered) return false;
  window.__bhqOrdered = { log: [], filled: [], startedAt: performance.now() };
  var S = window.__bhqOrdered;

  var SHOP = (window.Shopify && window.Shopify.shop) || '';
  if (!SHOP) return false;
  var API = API_ORIGIN + '/api/color-order';
  var BATCH = 24, WINDOW = 240, PREFETCH_PX = 2500;
  var COL = (location.pathname.split('/collections/')[1] || '').split('/')[0];
  var params = new URLSearchParams(location.search);

  // ---- 5. step aside on sort / non-colour filters --------------------------------
  var sort = params.get('sort_by');
  var otherFilter = Array.from(params.keys()).some(function (k) {
    return k.indexOf('filter.') === 0 && k !== 'filter.v.option.color';
  });
  if ((sort && sort !== 'manual') || otherFilter) return false;
  var colourFilter = params.getAll('filter.v.option.color').map(function (c) { return c.toLowerCase(); });

  var oldGrid = document.querySelector('#product-grid');
  if (!oldGrid || !COL) return false;
  var sectionEl = oldGrid.closest('[id^="shopify-section-"]');
  var sectionId = sectionEl ? sectionEl.id.replace('shopify-section-', '') : null;

  // ---- 1. decide first: load the frozen list (first window) ----------------------
  var list = [], listTotal = null, listCursor = 0, tail = [], windowLoading = null;
  // Keys lifted to the front by the boost. A lifted card can come from
  // position 922, so it is still sitting in window 4 and would be drawn a
  // second time when that window loads. Checked in nextEntries.
  var __bhqLifted = null;
  // Fetch the next 240-card section of the list once, in the background, before it runs out.
  function ensureWindow() {
    if (windowLoading || listTotal === null || list.length >= listTotal) return windowLoading;
    windowLoading = loadWindow(list.length).finally(function () { windowLoading = null; });
    return windowLoading;
  }
  async function loadWindow(offset) {
    var d = null;
    // The app embed starts this fetch at the top of <head>, so the first
    // window is usually already in flight - or in hand - by the time the
    // grid asks for it. Measured on a warm load without it: widget.js at
    // 350ms, config at 627ms, list at 709ms, each waiting on the last.
    // Only the first window, because that is the one the embed asked for.
    if (offset === 0 && window.__bhqColorListPromise) {
      try { d = await window.__bhqColorListPromise; } catch (e) { d = null; }
      // Used once: a later reload of the same window must go to the network
      // rather than replay a response from the previous page view.
      window.__bhqColorListPromise = null;
    }
    if (!d) {
      var r = await fetch(API + '?shop=' + SHOP + '&collection=' + COL + '&offset=' + offset + '&limit=' + WINDOW);
      if (!r.ok) throw new Error('list ' + r.status);
      d = await r.json();
    }
    if (!d || !d.cards) throw new Error('list empty');
    if (Date.now() - Number(d.builtAt) > 2 * 3600 * 1000) throw new Error('list stale');
    listTotal = d.total;
    d.cards.forEach(function (c) {
      // The row now carries what the card SHOWS, not just where it goes:
      // [handle, colour, img, variantId, soldOut, title, price, strike, badges].
      // Before this the renderer fetched /products/<handle>.js per product -
      // 40KB and ~160ms each, about 0.4MB for one batch of 24 cards. The
      // same batch is now 1.7KB, because the engine computed it hourly.
      list.push({
        h: c[0],
        colour: c[1] || '',
        img: c[2],
        vid: String(c[3] || ''),
        soldOut: !!c[4],
        title: c[5] || '',
        priceMinor: Number(c[6] || 0),
        strikeMinor: Number(c[7] || 0),
        badges: c[8] || []
      });
    });
  }
  try { await loadWindow(0); }
  catch (e) { S.log.push('fallback: ' + e.message); return false; }

  // ---- 1a. the returning shopper's boost, BEFORE anything is drawn ------------
  //
  // The split path boosts by reordering cards that are already on screen,
  // which is the movement this renderer exists to remove. Here the list is
  // reordered instead, while it is still data, so a boosted colour is drawn
  // in its boosted slot the first time it appears and never moves.
  //
  // The engaged products are looked up across the WHOLE list, not just the
  // window in hand. Searching the window alone failed the ordinary case: a
  // viewed product measured at position 922 of 2,907 never matched, so a
  // returning shopper saw a grid identical to a stranger's.
  //
  // One request, by handle, because the list is only ever held 240 cards at
  // a time and paging to position 922 would be four requests to place two
  // cards. Entries found this way are lifted to the front and removed from
  // wherever they sat, so no card is ever drawn twice.
  //
  // Scored by scoreBehaviour, the same helper the split path uses, so the
  // weights the merchant set and the recency decay apply identically and
  // there is one definition of what engagement is worth.
  if (__bhqBehaviourOn) {
    try {
      var bw = __bhqBehaviourWeights;
      var scored = scoreBehaviour({
        cart: num(bw && bw.cart, 12),
        wish: num(bw && bw.wish, 10),
        dwell: num(bw && bw.dwell, 5),
        views: num(bw && bw.views, 1),
      });
      if (scored.length) {
        var boost = {};
        var handles = [];
        for (var bi = 0; bi < scored.length; bi++) {
          var bh = String(scored[bi].handle).toLowerCase();
          boost[bh] = scored[bi].score;
          handles.push(bh);
        }
        // Their cards, wherever they sit in the collection. Failure is not
        // fatal: the grid then draws the merchandised order, which is what a
        // shopper with no history sees.
        var extra = [];
        try {
          var mr = await fetch(
            API + '?shop=' + SHOP + '&collection=' + COL +
            '&handles=' + encodeURIComponent(handles.slice(0, 20).join(',')),
          );
          if (mr.ok) {
            var md = await mr.json();
            var matched = (md && md.matched) || [];
            for (var mi = 0; mi < matched.length; mi++) {
              var c = matched[mi].card;
              extra.push({
                at: matched[mi].at,
                h: c[0],
                colour: c[1] || '',
                img: c[2],
                vid: String(c[3] || ''),
                soldOut: !!c[4],
                title: c[5] || '',
                priceMinor: Number(c[6] || 0),
                strikeMinor: Number(c[7] || 0),
                badges: c[8] || []
              });
            }
          }
        } catch (e) {
          S.log.push('boost lookup failed: ' + e.message);
        }
        // Boosted colours are LIFTED OUT of wherever they sit and placed
        // at the front; everything else keeps engine order behind them.
        //
        // Searching only the first window was wrong, and wrong in the
        // ordinary case: a shopper views a product, comes back to the
        // collection, and expects to see it. Measured - the viewed product
        // sat at list position 922 of 2,907, so a window-only pass reported
        // "0 of 240 matched" and the grid was identical to a stranger's.
        // The first test that passed only passed because that product
        // happened to be at position 121.
        //
        // Sold-out colours are never lifted: a colour they cannot buy is
        // not a better card for having been looked at.
        //
        // Capped, because the list is the whole collection: a shopper who
        // browsed twelve products should not be handed a first screen made
        // entirely of things they have already seen. The merchandised order
        // still has to show them something new.
        var LIFT_MAX = 8;
        var lifted = [];
        var takenKey = {};
        for (var xi = 0; xi < extra.length; xi++) {
          var ex = extra[xi];
          if (ex.soldOut) continue;
          if (lifted.length >= LIFT_MAX) break;
          var kk = ex.h + '|' + ex.colour;
          if (takenKey[kk]) continue;
          takenKey[kk] = 1;
          lifted.push({ e: ex, b: boost[String(ex.h).toLowerCase()] || 0, i: ex.at });
        }
        if (lifted.length) {
          // Strongest engagement first; ties keep engine order, so a
          // product's own colours stay in the order the engine ranked them.
          lifted.sort(function (a, b2) {
            if (b2.b !== a.b) return b2.b - a.b;
            return a.i - b2.i;
          });
          // Dropped from where they sat, so a lifted card is never drawn
          // twice. The window holds only the first 240 entries, so a card
          // from deeper in the list simply is not here to remove - and
          // nextEntries skips any key already placed.
          var front = [], keep = [];
          for (var fi2 = 0; fi2 < lifted.length; fi2++) {
            lifted[fi2].e.__lift = true;
            front.push(lifted[fi2].e);
          }
          for (var ki = 0; ki < list.length; ki++) {
            if (takenKey[list[ki].h + '|' + list[ki].colour]) continue;
            keep.push(list[ki]);
          }
          list = front.concat(keep);
          __bhqLifted = takenKey;
        }
        S.log.push('boost: lifted ' + lifted.length + ' from ' + extra.length + ' matched cards');
      }
    } catch (e) {
      // A boost that throws must not cost the shopper the grid.
      S.log.push('boost skipped: ' + e.message);
    }
  }

  // ---- template card: Shopify's own undecorated markup --------------------------
  //
  // Taken from a card already on the page, which costs nothing. Re-fetching
  // the collection as a section was measured at 151ms and 23KB on a warm
  // load, and it sat between the colour list and the first card being drawn -
  // the slowest step before the grid could appear.
  //
  // The clone is stripped of anything BadgeHQ may already have added, since
  // the badge pass can run before this does and a template carrying one
  // product's badges would stamp them onto every card.
  //
  // The section fetch stays as the fallback: a theme that renders its grid
  // entirely client-side would have no card to copy.
  var tpl = null;
  try {
    var onPage = oldGrid.querySelector('li.grid__item');
    if (onPage) {
      var cand = onPage.cloneNode(true);
      cand.querySelectorAll('.badgehq-info-stack, [class*="badgehq-"], [data-badgehq-pay]').forEach(function (n) {
        if (n.hasAttribute('data-badgehq-pay')) n.removeAttribute('data-badgehq-pay');
        else n.remove();
      });
      // Anything another app injected into the card, WishlistHero's heart
      // above all.
      //
      // A heart carries the handle of the product it was added to, so a
      // template copied from a live card gives every drawn card that one
      // product's heart - measured at 23 of 24 pointing at the template's
      // product. The section HTML had none of this, which is why fetching
      // the page did not have the problem and copying a card does.
      //
      // Same selector the click handler uses, so the two cannot disagree
      // about what a wishlist control is.
      cand.querySelectorAll(
        "[data-wlh-id], [data-wlh-handle], .wishlisthero-floating, " +
          ".wishlist-hero-custom-button, .wishlist-btn, [data-wishlist-hero], " +
          "[class*='wishlist'], [class*='Wishlist']",
      ).forEach(function (n) { n.remove(); });
      cand.removeAttribute('data-bhq-color');
      cand.removeAttribute('data-bhq-seen');
      cand.removeAttribute('data-bhq-color-rank');
      cand.removeAttribute('data-bhq-color-count');
      cand.removeAttribute('data-bhq-priced');
      // Only usable if it still has the parts every card is built from.
      // Drop the photo the template came with.
      //
      // A clone of a LOADED <img> inherits its decoded pixels, and assigning a
      // new src does not clear them: the element reports complete=false while
      // still holding naturalWidth=214 and painting the old picture until the
      // new file arrives. Verified by cloning a loaded card and reading the
      // element across the swap. Cached, that is a few ms; on a slow
      // connection it is the whole download, so every card showed the
      // template product's photo under its own name.
      //
      // The section-fetch template never had this - that HTML was parsed
      // fresh, so its images had never loaded. Removing the attributes here
      // puts the copy in the same state: no pixels to inherit.
      cand.querySelectorAll('img').forEach(function (im) {
        im.removeAttribute('src');
        im.removeAttribute('srcset');
        im.removeAttribute('data-src');
        im.removeAttribute('data-srcset');
      });
      if (cand.querySelector('img') && cand.querySelector('.card__heading') && cand.querySelector('.price')) {
        tpl = cand;
        S.log.push('template: from a card on the page');
      }
    }
  } catch (e) { tpl = null; }
  if (!tpl) {
    try {
      var html = (__bhqTplPromise && (await __bhqTplPromise)) || (await (await fetch(location.pathname + '?section_id=' + sectionId)).text());
      var doc = new DOMParser().parseFromString(html, 'text/html');
      tpl = doc.querySelector('#product-grid li.grid__item');
      S.log.push('template: from a section fetch');
    } catch (e) { /* fall through */ }
  }
  if (!tpl) { S.log.push('fallback: no template'); return false; }
  tpl.querySelectorAll('.badge, .card__badge').forEach(function (b) { b.remove(); });

  // fixed slot height = a real card at this viewport width
  var slotH = Math.round(oldGrid.querySelector('li.grid__item').getBoundingClientRect().height);

  // ---- 2. our own grid, same theme classes ---------------------------------------
  var grid = document.createElement('ul');
  grid.className = oldGrid.className;
  grid.id = 'bhq-ordered-grid';
  grid.setAttribute('role', 'list');
  oldGrid.insertAdjacentElement('afterend', grid);
  var hide = document.createElement('style');
  hide.id = 'bhq-ordered-hide';
  hide.textContent = '#product-grid,.collection__infinite-scroll-trigger,.jm-pagination{display:none!important}' +
    // min-height, not height, and no overflow clip.
    //
    // slotH is measured from one of Shopify's own cards, which carries no
    // badges and no "Get it for" line. A card drawn here does: measured
    // at 497px against a 471px slot, so overflow:hidden sliced the last
    // line in half on 15 of 24 cards.
    //
    // The placeholder still reserves slotH so the page keeps its length
    // while a batch is being filled; a filled card is simply allowed to
    // be as tall as it is. The grid is a CSS grid, so a taller card grows
    // its own row rather than overlapping the next one.
    '#bhq-ordered-grid>li{min-height:' + slotH + 'px}' +
    // height:100% needs a definite parent height, and the slot now only has
    // a minimum - so the placeholder carries slotH itself.
    '.bhq-ph{height:' + slotH + 'px;border-radius:8px;background:linear-gradient(90deg,#f1f1f1 25%,#e7e7e7 37%,#f1f1f1 63%);background-size:400% 100%;animation:bhqsh 1.2s ease infinite}' +
    '@keyframes bhqsh{0%{background-position:100% 50%}100%{background-position:0 50%}}';
  document.head.appendChild(hide);
  // The theme hides empty <div>s (div:empty{display:none}), so the marker must not be empty,
  // and the "near the end?" test uses the grid's own bottom edge, never the marker's position.
  var sentinel = document.createElement('div');
  sentinel.setAttribute('aria-hidden', 'true');
  sentinel.style.cssText = 'display:block!important;height:1px;overflow:hidden';
  sentinel.innerHTML = '&nbsp;';
  grid.insertAdjacentElement('afterend', sentinel);
  function nearEnd() { return grid.getBoundingClientRect().bottom < innerHeight + PREFETCH_PX; }


  // ---- live stock -----------------------------------------------------------------
  //
  // The engine's sold-out flag is up to an hour old, and a colour that sells
  // out inside that hour must not be drawn among the buyable ones.
  //
  // Read from the collection feed, which reports `available` per variant. The
  // obvious-looking /variants/<id>.json does NOT: it answers 200 with price and
  // options and no availability at all, and 404s for more than one id - so a
  // batch check built on it would have failed silently on every batch.
  //
  // A page is 250 products, about 337KB, and covers roughly 700 colour cards -
  // so a long scroll needs one or two. Fetched lazily: a shopper who never
  // scrolls never pays for it.
  var stock = {};
  var stockPages = 0;
  var stockLoading = null;
  // Latched when a page comes back empty. Without it the next batch asks for
  // the same exhausted page number again - stockPages only advances on a
  // non-empty read - so a deep scroll spends one dead request per batch.
  var stockDone = false;
  function loadStockPage() {
    if (stockDone) return Promise.resolve(0);
    if (stockLoading) return stockLoading;
    stockLoading = fetch(
      '/collections/' + COL + '/products.json?limit=250&page=' + (stockPages + 1),
      { credentials: 'same-origin' }
    )
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var ps = (d && d.products) || [];
        for (var i = 0; i < ps.length; i++) {
          for (var k = 0; k < ps[i].variants.length; k++) {
            var v = ps[i].variants[k];
            stock[String(v.id)] = !!v.available;
          }
        }
        if (ps.length) stockPages++;
        else stockDone = true;
        return ps.length;
      })
      .catch(function () { return 0; })
      .finally(function () { stockLoading = null; });
    return stockLoading;
  }
  // The first screen never waits for stock.
  //
  // The feed page is ~337KB. Awaiting it before the opening cards means grey
  // slots for as long as it takes, which on a slow connection is seconds - the
  // exact stall this renderer exists to remove. The row's own sold-out flag is
  // at most an hour old and is good enough for the first screen; the fetch is
  // kicked off in parallel and the batch after it has the answer.
  var stockWarmed = false;
  async function liveStock(entries) {
    // One more page, at most, per batch: enough to stay ahead of the shopper
    // without pulling the catalogue to draw 24 cards.
    var missing = entries.filter(function (e) {
      return e.vid && !stock.hasOwnProperty(e.vid);
    }).length;
    if (missing && !stockWarmed) {
      // Start it, don't await it: the shopper sees cards now.
      stockWarmed = true;
      loadStockPage();
    } else if (missing) {
      await loadStockPage();
    }
    var out = {};
    for (var i = 0; i < entries.length; i++) {
      var id = entries[i].vid;
      // Unknown stays unknown: the engine's flag then stands, which is the
      // behaviour before this check existed. A failed read never hides a
      // colour a shopper could have bought.
      if (id && stock.hasOwnProperty(id)) out[id] = stock[id];
    }
    return out;
  }
  // ---- 1b. prepare the next n entries: live stock decides BEFORE drawing ------------
  async function nextEntries(n) {
    var out = [];
    while (out.length < n) {
      if (list.length - listCursor < 80) ensureWindow();            // read ahead, don't wait
      if (listCursor >= list.length) {
        if (listTotal !== null && list.length < listTotal) { await ensureWindow(); continue; }
        if (tail.length) { out.push(tail.shift()); continue; }
        break;
      }
      var take = list.slice(listCursor, listCursor + (n - out.length) + 8);
      // Live stock for exactly these variants, in ONE request.
      //
      // The engine's sold-out flag is up to an hour old, and a colour that
      // sells out in that hour must not be drawn among the buyable ones.
      // Asked here, before anything is placed, so a card is never moved
      // after the shopper has seen it.
      var live = await liveStock(take);
      for (var i = 0; i < take.length && out.length < n; i++) {
        var e = take[i]; listCursor++;
        // A lifted colour appears twice in the list: once at the front
        // where the boost put it, and once where the engine ranked it,
        // inside a window that loads later. The front copy carries a flag;
        // any other copy is skipped, so the grid never shows it twice.
        if (!e.__lift && __bhqLifted && __bhqLifted[e.h + '|' + e.colour]) continue;
        if (colourFilter.length && colourFilter.indexOf(e.colour.toLowerCase()) < 0) continue;
        var avail = e.vid && live.hasOwnProperty(e.vid) ? live[e.vid] : !e.soldOut;
        if (!avail && !e.soldOut) { e.soldOut = true; tail.push(e); continue; } // sold out since run: to the tail
        out.push(e);
      }
    }
    return out;
  }

  // ---- 3. draw a complete card into a slot, once -----------------------------------
  var money = function (cents) { return '₹' + Math.round(cents / 100).toLocaleString('en-IN'); };
  var uid = 0;
  function fill(slot, e) {
    var li = tpl.cloneNode(true);
    // Everything from the row: no product fetch, so a card can be drawn
    // the moment its slot is reached.
    var url = '/products/' + e.h + (e.vid ? '?variant=' + e.vid : '');
    var title = e.title + (e.colour ? ' - ' + e.colour : '');
    uid++;
    li.querySelectorAll('[id]').forEach(function (el) { el.id = el.id + '-bhq' + uid; });
    li.querySelectorAll('[aria-labelledby]').forEach(function (el) {
      el.setAttribute('aria-labelledby', el.getAttribute('aria-labelledby').split(' ').map(function (x) { return x + '-bhq' + uid; }).join(' '));
    });
    li.querySelectorAll("a[href*='/products/']").forEach(function (a) { a.setAttribute('href', url); });
    li.querySelectorAll('.card__heading a').forEach(function (a) { a.textContent = title; });
    var src = 'https://cdn.shopify.com/s/files/' + e.img;
    li.querySelectorAll('img').forEach(function (img) {
      img.setAttribute('src', src + '?width=533');
      img.setAttribute('srcset', [165, 360, 533, 720, 940].map(function (w) { return src + '?width=' + w + ' ' + w + 'w'; }).join(', '));
      img.setAttribute('alt', title);
      img.removeAttribute('onload');
      img.style.opacity = '1';
      img.setAttribute('loading', 'lazy');
    });
    var price = li.querySelector('.price');
    if (price) {
      // The FINAL price, already discounted by the engine. The storefront
      // used to apply the Rs 100 Special Price rule itself, after the card
      // was on screen - which is why a card changed seconds after it was
      // drawn. One implementation now, and it runs before the draw.
      var onSale = e.strikeMinor > e.priceMinor;
      price.className = 'price' + (onSale ? ' price--on-sale' : '') + (e.soldOut ? ' price--sold-out' : '');
      price.querySelectorAll('.price-item--regular').forEach(function (el) {
        el.textContent = money(onSale ? e.strikeMinor : e.priceMinor);
      });
      price.querySelectorAll('.price-item--sale').forEach(function (el) {
        el.textContent = money(e.priceMinor);
      });
    }
    // Marks the card as priced by the engine.
    //
    // The widget's own price-rule pass rewrites a card's price from
    // productData.price, guarded by a __bhqPriceRule JS property - which a
    // card built here has never had. Without this attribute that pass would
    // discount an already-discounted price, so the two implementations the
    // engine was meant to replace would both run on the same card.
    li.setAttribute('data-bhq-priced', '');
    li.setAttribute('data-bhq-slot', String(slot.index));
    li.setAttribute('data-bhq-key', e.h + '|' + e.colour);
    if (e.soldOut) li.setAttribute('data-bhq-soldout', '');
    // No fixed height: the card sets its own, and the slot's min-height
    // keeps the reserved space. Pinning it here is what cropped the
    // "Get it for" line.
    li.style.minHeight = slotH + 'px';
    slot.el.replaceWith(li);          // same slot, same size: nothing moves
    slot.el = li;
    S.filled.push({ slot: slot.index, key: e.h + '|' + e.colour, at: Math.round(performance.now()) });
  }

  // ---- 3 + 4. batches: placeholders now, fill when data is ready ------------------
  // The next batch's cards are decided and their data fetched as soon as the previous
  // batch is drawn, so when the shopper gets near the end they are drawn immediately.
  var slots = [], busy = false, done = false, prepared = null;
  function prepare() { if (!prepared) prepared = nextEntries(BATCH); return prepared; }
  async function addBatch() {
    if (busy || done) return;
    busy = true;
    var t0 = performance.now();
    var batch = [];
    for (var i = 0; i < BATCH; i++) {
      var ph = document.createElement('li');
      ph.className = 'grid__item';
      ph.innerHTML = '<div class="bhq-ph"></div>';
      grid.appendChild(ph);
      var slot = { index: slots.length + 1, el: ph };
      slots.push(slot); batch.push(slot);
    }
    var entries = await prepare();
    prepared = null;
    batch.forEach(function (slot, i) {
      if (entries[i]) fill(slot, entries[i]);
      else { slot.el.remove(); done = true; }
    });
    S.log.push('batch ' + Math.ceil(slots.length / BATCH) + ': ' + entries.length + ' cards in ' + Math.round(performance.now() - t0) + 'ms');
    busy = false;
    if (!done) prepare();                       // get the following batch ready in the background
    maybeLoad();
  }
  function maybeLoad() { if (!busy && !done && nearEnd()) addBatch(); }
  // An IntersectionObserver only reports when the marker ENTERS the zone; a shopper already
  // inside the zone (e.g. at the very bottom) gets no new report, so also check on scroll.
  new IntersectionObserver(function (es) { if (es[0].isIntersecting) maybeLoad(); },
    { rootMargin: '0px 0px ' + PREFETCH_PX + 'px 0px' }).observe(sentinel);
  var ticking = false;
  addEventListener('scroll', function () {
    if (ticking) return; ticking = true;
    requestAnimationFrame(function () { ticking = false; maybeLoad(); });
  }, { passive: true });

  await addBatch();
  // Fix 4: back from a product page, draw as many cards as were loaded
  // before leaving, then put the shopper back at the same scroll position.
  if (__bhqRestore && !__bhqRestore.done) {
    var wantSlots = Math.min(__bhqRestore.n, 480);
    while (!done && slots.length < wantSlots) {
      while (busy) await new Promise(function (r) { setTimeout(r, 16); });
      if (done || slots.length >= wantSlots) break;
      await addBatch();
    }
    while (busy) await new Promise(function (r) { setTimeout(r, 16); });
    __bhqRestoreScroll();
    S.log.push('restored ' + slots.length + ' slots, scroll ' + __bhqRestore.y);
  }
  addEventListener('pagehide', function () {
    try {
      sessionStorage.setItem('bhq-grid-pos:' + location.pathname + location.search,
        JSON.stringify({ n: slots.length, y: Math.round(window.scrollY), t: Date.now() }));
    } catch (e) {}
  });
  S.log.push('frozen list ' + listTotal + ' cards, slot height ' + slotH + 'px');
  return true;
  }


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
      renderOrderedGrid().then(
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
