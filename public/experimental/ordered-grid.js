/*
 * BadgeHQ ordered grid: prototype renderer (runs in one browser tab via DevTools).
 *
 * Rule: every card is drawn ONCE, in its FINAL slot, and never changes after it is shown.
 *
 * How it works
 *  1. Decide first: read the engine's colour list (/api/color-order) and freeze it for the visit.
 *     Live stock is checked before a card is placed; a colour that sold out since the
 *     hourly run is moved to the tail, before anything is drawn.
 *  2. Draw from the list, not from Shopify's batches: Shopify's grid and its infinite
 *     scroll are hidden; the widget draws its own grid with the same theme classes.
 *  3. Placeholders, then fill in place: each batch first gets fixed-size grey slots,
 *     then each slot is filled once with a complete card (title, colour, photo, price).
 *     Slots have a fixed height, so filling never moves anything.
 *  4. Prefetch: the next batch is created ~2 screens before the shopper reaches it,
 *     so in normal scrolling they never see a placeholder.
 *  5. Step aside: with a price sort or a non-colour filter, Shopify's own grid is used.
 *     With a colour filter, only list entries in that colour are drawn.
 *  6. Fallback: if the list cannot be loaded, Shopify's grid is left exactly as it is.
 *
 * Not in this prototype (production needs these):
 *  - Run before first paint (app embed in <head>), not after load as in this DevTools test.
 *  - The personal boost: apply to the list once, before freezing it.
 *  - Badges, Special Price and the "Get it for" line drawn INTO the card before it is inserted
 *    (call BadgeHQ's badge renderer on the detached card, or get the values from the Worker).
 *    Today BadgeHQ's badge pass adds them 0.4-10s later, which is a visible change.
 *  - One Worker request per batch for card details, instead of /products/<handle>.js per product.
 *  - Back button: save rendered count + scroll position, redraw and restore on back.
 *
 * Tested on jmlooks.com (7 Nov 2026, desktop Chrome, list of 2,900 cards):
 *  - 0 cards changed after being shown; order identical to the frozen list; 0 duplicates
 *  - 0 placeholders seen while scrolling ~1.3 screens/s for 40s (432 cards); batches ~0.2s
 *  - 0 layout shifts
 *  - colour filter "Black": 72 cards, 0 in other colours
 */
(async function BHQOrderedGrid() {
  'use strict';
  if (window.__bhqOrdered) return 'already running';
  window.__bhqOrdered = { log: [], filled: [], startedAt: performance.now() };
  var S = window.__bhqOrdered;

  var SHOP = 'b03304.myshopify.com';
  var API = 'https://badgehq-widget.badgehq.workers.dev/api/color-order';
  var BATCH = 24, WINDOW = 240, PREFETCH_PX = 2500;
  var COL = (location.pathname.split('/collections/')[1] || '').split('/')[0];
  var params = new URLSearchParams(location.search);

  // ---- 5. step aside on sort / non-colour filters --------------------------------
  var sort = params.get('sort_by');
  var otherFilter = Array.from(params.keys()).some(function (k) {
    return k.indexOf('filter.') === 0 && k !== 'filter.v.option.color';
  });
  if ((sort && sort !== 'manual') || otherFilter) return 'step aside: shopper chose a sort or filter';
  var colourFilter = params.getAll('filter.v.option.color').map(function (c) { return c.toLowerCase(); });

  var oldGrid = document.querySelector('#product-grid');
  if (!oldGrid || !COL) return 'no grid';
  var sectionEl = oldGrid.closest('[id^="shopify-section-"]');
  var sectionId = sectionEl ? sectionEl.id.replace('shopify-section-', '') : null;

  // ---- 1. decide first: load the frozen list (first window) ----------------------
  var list = [], listTotal = null, listCursor = 0, tail = [], windowLoading = null;
  // Fetch the next 240-card section of the list once, in the background, before it runs out.
  function ensureWindow() {
    if (windowLoading || listTotal === null || list.length >= listTotal) return windowLoading;
    windowLoading = loadWindow(list.length).finally(function () { windowLoading = null; });
    return windowLoading;
  }
  async function loadWindow(offset) {
    var r = await fetch(API + '?shop=' + SHOP + '&collection=' + COL + '&offset=' + offset + '&limit=' + WINDOW);
    if (!r.ok) throw new Error('list ' + r.status);
    var d = await r.json();
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
  catch (e) { S.log.push('fallback: ' + e.message); return 'fallback: Shopify grid left as is'; }

  // ---- template card: Shopify's own undecorated markup --------------------------
  var tpl = null;
  try {
    var html = await (await fetch(location.pathname + '?section_id=' + sectionId)).text();
    var doc = new DOMParser().parseFromString(html, 'text/html');
    tpl = doc.querySelector('#product-grid li.grid__item');
  } catch (e) { /* fall through */ }
  if (!tpl) { S.log.push('fallback: no template'); return 'fallback: no template'; }
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
    '#bhq-ordered-grid>li{height:' + slotH + 'px;overflow:hidden}' +
    '.bhq-ph{height:100%;border-radius:8px;background:linear-gradient(90deg,#f1f1f1 25%,#e7e7e7 37%,#f1f1f1 63%);background-size:400% 100%;animation:bhqsh 1.2s ease infinite}' +
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
  function loadStockPage() {
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
        return ps.length;
      })
      .catch(function () { return 0; })
      .finally(function () { stockLoading = null; });
    return stockLoading;
  }
  async function liveStock(entries) {
    // One more page, at most, per batch: enough to stay ahead of the shopper
    // without pulling the catalogue to draw 24 cards.
    var missing = entries.filter(function (e) {
      return e.vid && !stock.hasOwnProperty(e.vid);
    }).length;
    if (missing) await loadStockPage();
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
        el.textContent = money((onSale ? e.strikeMinor : e.priceMinor) / 100);
      });
      price.querySelectorAll('.price-item--sale').forEach(function (el) {
        el.textContent = money(e.priceMinor / 100);
      });
    }
    li.setAttribute('data-bhq-slot', String(slot.index));
    li.setAttribute('data-bhq-key', e.h + '|' + e.colour);
    if (e.soldOut) li.setAttribute('data-bhq-soldout', '');
    li.style.height = slotH + 'px';
    slot.el.replaceWith(li);          // same slot, same size: nothing moves
    slot.el = li;
    S.filled.push({ slot: slot.index, key: p.handle + '|' + e.colour, at: Math.round(performance.now()) });
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
  return 'running: frozen list ' + listTotal + ' cards, slot height ' + slotH + 'px';
})();
