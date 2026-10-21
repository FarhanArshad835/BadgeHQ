/**
 * BadgeHQ - Storefront Widget Script
 * Vanilla JS, no dependencies. Injected into store themes.
 * Fetches config from app server and renders all active widgets.
 */
(function () {
  "use strict";

  var SHOP = window.Shopify && window.Shopify.shop;
  if (!SHOP) return;

  // Derive the app server URL from this script's own src attribute
  // (the ScriptTag points to ${SHOPIFY_APP_URL}/widget.js)
  var scriptEl = document.currentScript || (function () {
    var scripts = document.getElementsByTagName("script");
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (scripts[i].src && scripts[i].src.indexOf("widget.js") !== -1) {
        return scripts[i];
      }
    }
    return null;
  })();

  // Hardcoded API origin — points at the Cloudflare Worker which proxies
  // /api/widgets and /api/products/inventory to Vercel with edge caching.
  // The worker caches responses for 5 minutes via cf.cacheTtl, so Vercel
  // only sees ~1 request per shop per 5 minutes instead of one per
  // pageview — >99% reduction for these dynamic endpoints.
  //
  // Vercel still serves the same endpoints at https://badge-hq.vercel.app
  // — that's where the actual Remix app + Postgres + Shopify Admin API
  // integration runs, and what the worker proxies through to. This URL
  // is purely the storefront-facing edge layer.
  var API_ORIGIN = "https://badgehq-widget.badgehq.workers.dev";

  var API_URL = API_ORIGIN + "/api/widgets?shop=" + encodeURIComponent(SHOP);

  // Server-side inventory feed (Admin API-backed). Returns per-handle totals
  // including inventory, regardless of whether Shopify hides inventory in
  // the public storefront API. Populated into _productDataCache during
  // bulk prefetch.
  var INVENTORY_API_URL = API_ORIGIN + "/api/products/inventory?shop=" + encodeURIComponent(SHOP);

  // Delivery-estimate endpoint (Delhivery Expected TAT). The merchant's API
  // token lives server-side only; this returns {serviceable, etaDate, etaText}.
  var DELIVERY_API_URL = API_ORIGIN + "/api/delivery-edd?shop=" + encodeURIComponent(SHOP);

  function onReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }

  /**
   * Cart-write hooks, installed NOW rather than after the config fetch.
   *
   * widget.js is loaded async and everything else waits on a network round
   * trip, so by the time initBadgeHQ runs the theme has long since bound its
   * own add-to-cart handler and captured window.fetch. Wrapping it then is too
   * late: the add fires through the original reference and is never seen.
   *
   * These only set a flag. Nothing is recorded until the beacon starts and
   * decides whether tracking is even enabled for this shop.
   */
  /**
   * Intercept the theme's scroll-page fetch so the page can be rebuilt.
   *
   * Installed here, at parse time, for the same reason the cart hooks are: the
   * theme captures window.fetch when it loads, and wrapping it afterwards is
   * too late - the call goes through the original reference and is never seen.
   *
   * Set up now, armed later. __bhqPageRewriter stays null until the behaviour
   * beacon has the ranked order, so a page is only ever rewritten when there is
   * something to rewrite it with; until then the response passes straight
   * through untouched.
   */
  /** How long a scroll page may spend being rebuilt before the original is
   *  served instead.
   *
   *  The rebuild fetches up to MAX_SWAPS cards, in parallel, so on a warm
   *  connection it finishes in roughly one card's time. The budget matters on
   *  a slow one, and at 2.5s it was tight enough that a page could be served
   *  without the products the shopper had just asked for, silently. */
  var REWRITE_BUDGET_MS = 4000;
  /** Images warmed for the next page: the first two rows of a 2-up phone
   *  grid plus a little margin. All 24 would be ~1.4MB the shopper may never
   *  scroll to. */
  var IMG_PREFETCH_COUNT = 6;
  /** Cards on an appended page whose image loads eagerly: one row on a 2-up
   *  phone grid, which is what is on screen the instant the page lands. */
  var EAGER_ROW_COUNT = 2;

  /** Set once the reorder is running, so an engagement anywhere on the page
   *  can warm the cards it just made relevant.
   *
   *  Lead cards were only prefetched on page load, when the behaviour bag is
   *  empty for most shoppers - so a wishlist click warmed nothing and all
   *  eight cards were fetched at scroll time, which is the moment that had to
   *  be fast. */
  var __bhqOnEngage = null;

  /** Run when the browser is not busy, so prefetching never competes with the
   *  page the shopper is actually looking at. */
  function idle(fn) {
    if (window.requestIdleCallback) window.requestIdleCallback(fn, { timeout: 2000 });
    else setTimeout(fn, 200);
  }
  var __bhqPageRewriter = null;
  /** Scroll pages fetched before the shopper asked for them, by URL.
   *
   *  The theme only starts loading the next page when the shopper is 200px
   *  from the bottom - less than half a screen on a phone - and Shopify takes
   *  around a second to answer on a slow connection. Starting that request
   *  while they are still reading turns the wait into nothing.
   *
   *  Shopify marks these responses private, max-age=0, so the browser will
   *  not reuse one from its own cache; the text is held here instead. */
  var __bhqPagePrefetch = {};
  (function installPageHook() {
    var PAGE_FETCH = /[?&]section_id=/;
    try {
      var of = window.fetch;
      if (!of) return;
      // The unhooked fetch, for our own requests.
      //
      // Prefetching a scroll page through the hook made the hook rewrite it
      // on the way in, which marked those products as shown; the theme then
      // asked for the same page, the hook rewrote the already-rewritten
      // HTML, and every product it had just chosen was skipped as already
      // shown. A shopper who wishlisted a boot got eight boot cards fetched
      // and then replaced by whatever was next in the ranking.
      //
      // The rewrite belongs at serve time regardless: behaviour can change
      // between prefetching a page and the shopper reaching it.
      window.__bhqRawFetch = function () {
        return of.apply(window, arguments);
      };
      window.fetch = function (input) {
        var u = typeof input === "string" ? input : (input && input.url) || "";
        if (!PAGE_FETCH.test(u) || u.indexOf("page=") === -1) {
          return of.apply(this, arguments);
        }
        // Already fetched while the shopper was reading: hand it straight
        // back rather than asking Shopify again.
        var pre = __bhqPagePrefetch[u];
        var self = this;
        var args = arguments;
        var r = pre
          ? pre.then(
              function (html) {
                return new Response(html, {
                  status: 200,
                  headers: { "Content-Type": "text/html" },
                });
              },
              function () {
                // A prefetch that failed MID-FLIGHT, which on a slow
                // connection is the common way for it to fail. Without this
                // the theme is handed the rejection and the shopper sees
                // nothing until they scroll again.
                delete __bhqPagePrefetch[u];
                return of.apply(self, args);
              },
            )
          : of.apply(self, args);
        // Armed only once the ranked order has loaded. A shopper who
        // scrolls before that lands gets the page unrewritten, which is
        // correct but worth being able to see.
        if (!__bhqPageRewriter) {
          if (window.console && console.warn) {
            console.warn("[BHQ] rewriter not armed yet, page served unmodified:", u);
          }
          return r;
        }
        // The response is read once here and handed back as a fresh one, so
        // the theme still sees an ordinary Response it can call text() on.
        return r
          .then(function (res) {
            if (!res.ok) return res;
            return res.text().then(function (html) {
              return new Promise(function (resolve) {
                var done = false;
                var finish = function (out) {
                  if (done) return;
                  done = true;
                  resolve(
                    new Response(out, {
                      status: res.status,
                      headers: { "Content-Type": "text/html" },
                    }),
                  );
                };
                // A rewrite that stalls must not strand the shopper mid-scroll:
                // past this the original page is used unchanged.
                // Serving Shopify's page unchanged is the right failure, but
                // it is indistinguishable from the rewrite having run and
                // chosen the same products - so it says so.
                setTimeout(function () {
                  if (!done && window.console && console.warn) {
                    console.warn("[BHQ] rewrite timed out, page served unmodified:", u);
                  }
                  finish(html);
                }, REWRITE_BUDGET_MS);
                try {
                  __bhqPageRewriter(u, html, finish);
                } catch (e) {
                  finish(html);
                }
              });
            });
          })
          .catch(function () {
            return r;
          });
      };
    } catch (e) {
      /* a theme that froze fetch is not worth breaking the widget over */
    }
  })();

  /**
   * Hold the grid back until its order is settled.
   *
   * The reorder waits on two network calls - the config, then the ranked order
   * - so the cards Shopify sent have been on screen for roughly half a second
   * by the time they move. The shopper watches the grid rearrange under them,
   * which reads as a glitch rather than as personalisation.
   *
   * The grid is faded out for that window instead. Done with a stylesheet
   * injected at parse time, before the first paint: a style applied later
   * would itself be a visible change.
   *
   * Every exit releases it - success, failure, or a 1.2s deadline - because a
   * grid that stays hidden is far worse than one that visibly reorders. The
   * deadline is also why this is opacity rather than display: the layout is
   * already correct underneath, so releasing it mid-flight shows the page as
   * it would otherwise have looked, with nothing jumping.
   */
  /** The ranked order, fetched the moment the script runs.
   *
   *  The reorder used to start this only after the config had arrived, which
   *  chained two requests that have nothing to do with each other: ~450ms for
   *  the config and then ~900ms for this, so the grid could not be sorted for
   *  about 1.4s. The veil could not outlast that without holding the page
   *  blank, so it lifted first and the shopper watched the cards rearrange.
   *
   *  Nothing here depends on the config, so it runs alongside it instead and
   *  the order is usually in hand before the config has finished. */
  var __bhqOrderPromise = null;
  (function prefetchOrder() {
    try {
      if (!SHOP) return;
      if (!/\/collections\//.test(location.pathname) && location.pathname !== "/") return;
      __bhqOrderPromise = fetch(
        API_ORIGIN + "/api/order?shop=" + encodeURIComponent(SHOP),
      ).then(function (r) {
        return r.json();
      });
      // A rejection here must not surface as an unhandled promise; the
      // consumer re-attaches its own handlers and falls back to fetching.
      __bhqOrderPromise.catch(function () {});
    } catch (e) {
      __bhqOrderPromise = null;
    }
  })();

  /**
   * Hide the grid, but only when something is about to move.
   *
   * Previously this ran on every collection load, from <head>, and released
   * on a 1.2s then 2s timer. That was wrong twice over: on a managed
   * collection nothing moves, so the delay bought nothing, and the timer
   * fired before the ranked order had arrived - so the grid was revealed
   * unsorted and then reordered in front of the shopper, which is exactly the
   * flash it was meant to prevent.
   *
   * Now it is applied only once the order and the behaviour are both in hand
   * AND they disagree with what Shopify sent - and it is released as soon as
   * the cards have been placed, not on a clock.
   */
  /**
   * Hide the grid before its first paint, for an engaged shopper only.
   *
   * A shopper with no behaviour gets the server order, which Shopify has
   * already applied, so their grid is correct as it arrives and is never
   * hidden - no veil, no delay, nothing to cover.
   *
   * A shopper who has engaged does get a different order, and that reorder
   * has to be hidden while it happens. Raising the veil at the moment of the
   * reorder was too late: the grid was already on screen, so hiding it then
   * blinked it to blank and revealed it again, which looks worse than the
   * movement it was covering.
   *
   * Behaviour lives in sessionStorage, so whether this shopper is in that
   * minority is knowable synchronously, right now, with no network - which is
   * what makes it possible to decide before the first paint instead of after.
   */
  var __bhqEngaged = false;
  (function veilIfEngaged() {
    try {
      if (!/\/collections\//.test(location.pathname) && location.pathname !== "/") return;
      var raw = sessionStorage.getItem("badgehq-behaviour");
      if (!raw) return;
      var bag = JSON.parse(raw);
      var list = (bag && bag.b) || [];
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        if (!b || !b.h) continue;
        // Any recorded interaction at all; the scoring decides what it is
        // worth later. This only answers "might the order differ?".
        if (b.v || b.d || b.ca || b.cr || b.wa || b.wr) {
          __bhqEngaged = true;
          break;
        }
      }
      // Not veiled any more. The app embed reorders the cards in place
      // before the browser paints them, using the order cached on the page
      // view where this shopper engaged - so the grid arrives correct and
      // there is no movement left to cover. Hiding it here would only
      // delay a grid that is already in the right order.
      //
      // __bhqEngaged is still tracked: the first-ever visit has no cached
      // order for the embed to use, and that load is handled below.
    } catch (e) {
      /* no storage, or malformed - treat as not engaged and never hide */
    }
  })();

  var __bhqVeiled = false;
  function veilGridNow() {
    if (__bhqVeiled) return;
    __bhqVeiled = true;
    try {
      var st = document.createElement("style");
      st.id = "badgehq-veil";
      st.textContent =
        "#product-grid,[id^='main-collection-product-grid'] ul{opacity:0}" +
        ".badgehq-ready #product-grid,.badgehq-ready [id^='main-collection-product-grid'] ul{opacity:1;transition:opacity .18s ease}";
      (document.head || document.documentElement).appendChild(st);
      // A hard ceiling. This now goes up before the first paint, so it has
      // to outlast fetching the ranked order - measured at ~480ms from the
      // edge cache - without being long enough to be felt if that fetch
      // fails. Only an engaged shopper is ever hidden at all, and every
      // exit releases explicitly; this is the backstop for none of them
      // being reached.
      setTimeout(__bhqUnveil, 900);
    } catch (e) {
      /* never let this be why a grid stays blank */
    }
  }
  function __bhqUnveil() {
    if (!__bhqVeiled) return;
    try {
      var root = document.documentElement;
      if (root && root.className.indexOf("badgehq-ready") === -1) {
        root.className += " badgehq-ready";
      }
    } catch (e) {
      /* nothing to do */
    }
  }

  var __bhqCartDirty = false;
  var __bhqOnCartWrite = null;
  (function installCartHooks() {
    var CART_WRITE = /\/cart\/(add|change|update|clear)/;
    var fire = function () {
      __bhqCartDirty = true;
      if (__bhqOnCartWrite) __bhqOnCartWrite();
    };
    try {
      var of = window.fetch;
      if (of) {
        window.fetch = function (input) {
          var u = typeof input === "string" ? input : (input && input.url) || "";
          var r = of.apply(this, arguments);
          if (CART_WRITE.test(u) && r && r.then) r.then(fire, function () {});
          return r;
        };
      }
      var os = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m, u) {
        if (CART_WRITE.test(String(u || ""))) this.addEventListener("load", fire);
        return os.apply(this, arguments);
      };
    } catch (e) {
      /* a theme that froze these is not worth breaking the widget over */
    }
  })();

  fetch(API_URL)
    .then(function (r) {
      return r.json();
    })
    .then(function (data) {
      if (!data.enabled) return;
      window.__BADGEHQ__ = data;
      onReady(function () {
        initBadgeHQ(data);
      });
    })
    .catch(function (e) {
      console.warn("BadgeHQ: Failed to load config", e);
    });

  function initBadgeHQ(data) {
    var gs = data.globalSettings || {};
    var w = data.widgets || {};
    var currencySymbol = data.currencySymbol || "$";
    var page = detectPage();

    if (w.announcementBars)
      w.announcementBars.forEach(function (bar) {
        renderAnnouncementBar(bar, page);
      });
    if (w.trustBadges)
      w.trustBadges.forEach(function (badge) {
        renderTrustBadge(badge, page, gs);
      });
    if (w.productBadges) renderProductBadges(w.productBadges, page);
    if (w.bundleOffers) renderBundleOffers(w.bundleOffers, page, currencySymbol);
    // Started even with no shipping bars, because bundle offers need the same
    // cart-change refresh and this is the only place it is wired.
    if (w.freeShippingBars || w.bundleOffers) {
      (w.freeShippingBars || []).forEach(function (bar) {
        renderFreeShippingBar(bar, page, currencySymbol);
      });
      setupCartChangeListener(w.freeShippingBars || [], page, currencySymbol, w.bundleOffers || []);
    }
    if (w.stickyCarts)
      w.stickyCarts.forEach(function (cart) {
        renderStickyCart(cart, currencySymbol);
      });
    if (w.countdownTimers)
      w.countdownTimers.forEach(function (timer) {
        renderCountdownTimer(timer, page, gs);
      });
    if (w.deliveryEstimate && w.deliveryEstimate.enabled && page === "product")
      renderDeliveryEstimate(w.deliveryEstimate);
    // The classic customer-account order page maps to the "account" surface.
    // Other surfaces (new customer account, thank-you) are served by the app
    // UI extension, not this script.
    if (
      w.orderManagement &&
      w.orderManagement.enabled &&
      page === "order" &&
      (!w.orderManagement.showOnPages ||
        w.orderManagement.showOnPages.indexOf("account") !== -1)
    )
      renderOrderActions();
    if (w.wishlist && w.wishlist.enabled) initWishlist(w.wishlist, page);
    if (w.backInStock && w.backInStock.enabled && page === "product")
      initBackInStock(w.backInStock);
    // Chat belongs on every page, so no page gate here.
    if (w.aiReplies && w.aiReplies.enabled) initAiReplies(w.aiReplies);

    if (w.behaviourTracking) initBehaviourBeacon(page);
    if (w.behaviourTracking) reorderGridForShopper(page, w.behaviourWeights);

    if (page === "product") setupProductRerenderWatch(data, page);
    else setupCardRerenderWatch(data, page);
  }

  // Lightweight observer for non-product pages: re-runs the wishlist card-
  // heart pass after infinite scroll / section swaps re-render product cards.
  function setupCardRerenderWatch(data, page) {
    if (!window.MutationObserver) return;
    var w = data.widgets || {};
    if (!(w.wishlist && w.wishlist.enabled && w.wishlist.showOnCards)) return;
    var debounce = null;
    var observer = new MutationObserver(function () {
      clearTimeout(debounce);
      debounce = setTimeout(function () { wlDecorateCards(w.wishlist); }, 400);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("shopify:section:load", function () { wlDecorateCards(w.wishlist); });
  }

  // Some themes (Dawn descendants like "Release") re-render the whole
  // product-info subtree via the Section Rendering API on variant change,
  // wiping anything we injected near the buy buttons. Watch for our roots
  // disappearing and re-run the (idempotent) product-page renderers.
  function setupProductRerenderWatch(data, page) {
    if (!window.MutationObserver) return;
    var gs = data.globalSettings || {};
    var w = data.widgets || {};
    var currencySymbol = data.currencySymbol || "$";

    function missing(id) {
      return !document.getElementById(id);
    }

    function reinject() {
      if (w.trustBadges)
        w.trustBadges.forEach(function (badge) {
          if (missing("badgehq-trust-" + badge.id)) renderTrustBadge(badge, page, gs);
        });
      if (w.freeShippingBars)
        w.freeShippingBars.forEach(function (bar) {
          if (shouldShowOnPage(bar.pages, page) && missing("badgehq-freeship-" + bar.id))
            renderFreeShippingBar(bar, page, currencySymbol);
        });
      if (w.countdownTimers)
        w.countdownTimers.forEach(function (timer) {
          if (missing("badgehq-countdown-" + timer.id)) renderCountdownTimer(timer, page, gs);
        });
      if (w.deliveryEstimate && w.deliveryEstimate.enabled && missing("badgehq-delivery-estimate"))
        mountDeliveryEstimate(w.deliveryEstimate, 0);
      if (w.wishlist && w.wishlist.enabled) {
        if (w.wishlist.showOnProduct && missing("badgehq-wl-product"))
          wlMountProductButton(w.wishlist, 0);
        if (w.wishlist.showOnCards) wlDecorateCards(w.wishlist);
      }
    }

    var debounce = null;
    var observer = new MutationObserver(function () {
      // Debounce: section swaps arrive as bursts of mutations, and our own
      // re-injection also mutates the DOM (the idempotency guards make the
      // follow-up pass a no-op, so this can't loop).
      clearTimeout(debounce);
      debounce = setTimeout(reinject, 400);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // The theme fires this on section swaps (design mode + some runtime paths).
    document.addEventListener("shopify:section:load", reinject);

    // Belt-and-suspenders: the variant swap a `?variant=` URL triggers can land
    // just after our first mount and before the observer is armed. Poll a few
    // times over the first ~5s so the widgets survive that initial reflow.
    var checks = 0;
    var early = setInterval(function () {
      reinject();
      if (++checks >= 10) clearInterval(early);
    }, 500);
  }

  function detectPage() {
    var path = window.location.pathname;
    if (path.indexOf("/account") !== -1 && path.match(/\/orders\//)) return "order";
    if (path.match(/\/products\//)) return "product";
    if (path.match(/\/cart/)) return "cart";
    if (path.match(/\/collections\//)) return "collection";
    // Match homepage: exactly "/" or Shopify Markets locale prefixes like /en, /fr, /en-US
    if (path === "/" || path === "" || /^\/[a-z]{2}(-[a-z]{2,4})?\/?\s*$/i.test(path)) return "home";
    return "other";
  }

  function shouldShowOnPage(pages, currentPage) {
    if (!pages || pages.length === 0) return true;
    if (pages.indexOf("all") !== -1) return true;
    return pages.indexOf(currentPage) !== -1;
  }

  /* ===================== ANNOUNCEMENT BAR ===================== */
  function renderAnnouncementBar(bar, page) {
    if (!shouldShowOnPage(bar.pages, page)) return;
    if (bar.schedule) {
      var now = new Date();
      if (bar.schedule.startDate && new Date(bar.schedule.startDate) > now)
        return;
      if (bar.schedule.endDate && new Date(bar.schedule.endDate) < now) return;
    }

    var el = document.createElement("div");
    el.id = "badgehq-announcement-" + bar.id;
    el.style.cssText =
      "background:" +
      bar.bgColor +
      ";color:" +
      bar.textColor +
      ";padding:10px 40px;text-align:center;font-size:14px;position:relative;z-index:9999;";

    var msgs = bar.messages || [];
    var idx = 0;
    var textEl = document.createElement("span");

    function showMsg() {
      if (msgs.length === 0) return;
      var m = msgs[idx % msgs.length];
      textEl.textContent = (m.emoji ? m.emoji + " " : "") + m.text;
    }
    showMsg();
    el.appendChild(textEl);

    if (msgs.length > 1) {
      setInterval(function () {
        idx++;
        textEl.style.opacity = "0";
        setTimeout(function () {
          showMsg();
          textEl.style.opacity = "1";
        }, 300);
      }, 4000);
      textEl.style.transition = "opacity 0.3s";
    }

    if (bar.showClose) {
      var closeBtn = document.createElement("span");
      closeBtn.textContent = "\u00D7";
      closeBtn.style.cssText =
        "position:absolute;right:12px;top:50%;transform:translateY(-50%);cursor:pointer;font-size:18px;opacity:0.7;";
      closeBtn.onclick = function () {
        el.style.transition = "max-height 0.3s,padding 0.3s,opacity 0.3s";
        el.style.maxHeight = "0";
        el.style.padding = "0";
        el.style.opacity = "0";
        el.style.overflow = "hidden";
        setTimeout(function () {
          el.remove();
        }, 300);
      };
      el.appendChild(closeBtn);
    }

    document.body.insertBefore(el, document.body.firstChild);
  }

  /* ===================== TRUST BADGES ===================== */
  // Inject CSS animations once
  (function injectAnimationCSS() {
    if (document.getElementById("badgehq-animations")) return;
    var style = document.createElement("style");
    style.id = "badgehq-animations";
    style.textContent =
      "@keyframes badgehq-fadeIn{from{opacity:0}to{opacity:1}}" +
      "@keyframes badgehq-slideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}" +
      "@keyframes badgehq-bounce{0%,20%,50%,80%,100%{transform:translateY(0)}40%{transform:translateY(-12px)}60%{transform:translateY(-6px)}}";
    document.head.appendChild(style);
  })();

  // Badge library image map - generates SVG data URIs on the fly
  function badgeSvgUrl(text, bg, fg) {
    fg = fg || "#fff";
    return (
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40">' +
          '<rect width="120" height="40" rx="6" fill="' + bg + '"/>' +
          '<text x="60" y="25" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" font-weight="700" fill="' + fg + '">' + text + "</text>" +
          "</svg>"
      )
    );
  }

  function shieldSvgUrl(text, bg, fg) {
    fg = fg || "#fff";
    return (
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40">' +
          '<path d="M60 2 L110 12 L110 28 Q110 38 60 38 Q10 38 10 28 L10 12 Z" fill="' + bg + '"/>' +
          '<text x="60" y="25" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" font-weight="700" fill="' + fg + '">' + text + "</text>" +
          "</svg>"
      )
    );
  }

  function circleSvgUrl(text, bg, fg) {
    fg = fg || "#fff";
    return (
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
          '<circle cx="20" cy="20" r="18" fill="' + bg + '"/>' +
          '<text x="20" y="24" text-anchor="middle" font-family="Arial,sans-serif" font-size="7" font-weight="700" fill="' + fg + '">' + text + "</text>" +
          "</svg>"
      )
    );
  }

  var BADGE_IMAGE_MAP = {
    visa: badgeSvgUrl("VISA", "#1a1f71"),
    mastercard: badgeSvgUrl("Mastercard", "#eb001b"),
    amex: badgeSvgUrl("AMEX", "#006fcf"),
    paypal: badgeSvgUrl("PayPal", "#003087"),
    "apple-pay": badgeSvgUrl("Apple Pay", "#000"),
    "google-pay": badgeSvgUrl("Google Pay", "#4285F4"),
    stripe: badgeSvgUrl("Stripe", "#635bff"),
    discover: badgeSvgUrl("Discover", "#ff6000"),
    bitcoin: badgeSvgUrl("Bitcoin", "#f7931a"),
    "shopify-pay": badgeSvgUrl("Shop Pay", "#5a31f4"),
    klarna: badgeSvgUrl("Klarna", "#ffb3c7", "#0a0b09"),
    afterpay: badgeSvgUrl("Afterpay", "#b2fce4", "#000"),
    venmo: badgeSvgUrl("Venmo", "#008CFF"),
    "samsung-pay": badgeSvgUrl("Samsung Pay", "#1428a0"),
    "diners-club": badgeSvgUrl("Diners Club", "#0079be"),
    "ssl-secure": shieldSvgUrl("SSL Secure", "#27ae60"),
    "256-bit": shieldSvgUrl("256-Bit SSL", "#2c3e50"),
    "norton-secured": shieldSvgUrl("Norton", "#ffc629", "#000"),
    "mcafee-secure": shieldSvgUrl("McAfee", "#c8102e"),
    "secure-checkout": shieldSvgUrl("Secure", "#3498db"),
    "dmca-protected": shieldSvgUrl("DMCA", "#1a237e"),
    "pci-compliant": shieldSvgUrl("PCI DSS", "#00695c"),
    "bbb-accredited": shieldSvgUrl("BBB A+", "#005a8c"),
    "trusted-site": shieldSvgUrl("Trusted", "#43a047"),
    "verified-secure": shieldSvgUrl("Verified", "#1565c0"),
    "gdpr-compliant": shieldSvgUrl("GDPR", "#0d47a1"),
    "safe-secure": shieldSvgUrl("100% Safe", "#388e3c"),
    "free-shipping": badgeSvgUrl("Free Shipping", "#00897b"),
    "fast-delivery": badgeSvgUrl("Fast Delivery", "#ef6c00"),
    "easy-returns": badgeSvgUrl("Easy Returns", "#5c6bc0"),
    "free-returns": badgeSvgUrl("Free Returns", "#7b1fa2"),
    "worldwide-shipping": badgeSvgUrl("Worldwide", "#0277bd"),
    "same-day": badgeSvgUrl("Same Day", "#c62828"),
    "tracked-delivery": badgeSvgUrl("Tracked", "#37474f"),
    "express-shipping": badgeSvgUrl("Express", "#d84315"),
    "30-day-returns": badgeSvgUrl("30-Day Returns", "#6a1b9a"),
    "carbon-neutral": badgeSvgUrl("Carbon Neutral", "#2e7d32"),
    "money-back": circleSvgUrl("Money Back", "#f57f17"),
    satisfaction: circleSvgUrl("100%", "#43a047"),
    authentic: circleSvgUrl("Authentic", "#1565c0"),
    "quality-assured": circleSvgUrl("Quality", "#6a1b9a"),
    "award-winner": circleSvgUrl("Award", "#ff8f00"),
    "top-rated": circleSvgUrl("Top Rated", "#d32f2f"),
    "best-seller": circleSvgUrl("Best Seller", "#c62828"),
    "customer-favorite": circleSvgUrl("Favorite", "#e91e63"),
    "24-7-support": badgeSvgUrl("24/7 Support", "#00838f"),
    "live-chat": badgeSvgUrl("Live Chat", "#00695c"),
    "price-match": badgeSvgUrl("Price Match", "#4527a0"),
    warranty: badgeSvgUrl("Warranty", "#1b5e20"),
    natural: badgeSvgUrl("100% Natural", "#2e7d32"),
    cotton: badgeSvgUrl("100% Cotton", "#5d4037"),
    fresh: badgeSvgUrl("100% Fresh", "#00c853"),
    "eco-friendly": badgeSvgUrl("Eco Friendly", "#1b5e20"),
    "easy-to-return": badgeSvgUrl("Easy Return", "#4a148c"),
    "authorized-dealer": badgeSvgUrl("Authorized", "#283593"),
    handmade: badgeSvgUrl("Handmade", "#795548"),
    "limited-edition": badgeSvgUrl("Limited Ed.", "#b71c1c"),
    "cruelty-free": badgeSvgUrl("Cruelty Free", "#e91e63"),
    vegan: badgeSvgUrl("Vegan", "#4caf50"),
  };

  function renderTrustBadge(badge, page, gs) {
    var s = badge.settings || {};
    var pos = s.position || "below-atc";

    // Only render on product pages for ATC positions, or cart page for cart-page position
    if (pos === "cart-page" && page !== "cart") return;
    if (pos !== "cart-page" && page !== "product") return;

    // Idempotent: skip if already in the DOM (the re-inject watcher re-runs
    // renderers after themes wipe the product info on variant change).
    if (document.getElementById("badgehq-trust-" + badge.id)) return;

    var isDark = s.colorScheme === "dark";
    var bgColor = isDark ? "#1a1a2e" : "#ffffff";
    var borderColor = isDark ? "#333" : "#e5e5e5";
    var headerColor = isDark ? "#ffffff" : (s.textColor || "#242D35");
    var badgeSize = s.badgeSize || 60;
    var gap = s.showSpacing !== false ? "10px" : "4px";
    var padding = s.showPadding !== false ? "20px" : "8px";
    var justifyMap = { left: "flex-start", center: "center", right: "flex-end" };
    var justify = justifyMap[s.align] || "center";

    // Animation CSS
    var animStyle = "";
    if (s.animation === "fadeIn") animStyle = "animation:badgehq-fadeIn 0.6s ease-out;";
    else if (s.animation === "slideUp") animStyle = "animation:badgehq-slideUp 0.6s ease-out;";
    else if (s.animation === "bounce") animStyle = "animation:badgehq-bounce 1s ease;";

    var container = document.createElement("div");
    container.id = "badgehq-trust-" + badge.id;
    container.style.cssText =
      "background:" + bgColor + ";border:1px solid " + borderColor +
      ";border-radius:8px;padding:" + padding +
      ";text-align:" + (s.align || "center") +
      ";margin:12px 0;font-family:" + (s.fontFamily || gs.fontFamily || "inherit") +
      ";" + animStyle;

    // Header
    if (s.showHeader !== false) {
      var title = document.createElement("p");
      title.textContent = s.headerText || "Guaranteed Safe Checkout";
      title.style.cssText =
        "margin:0 0 12px;font-weight:" + (s.fontWeight || 600) +
        ";font-size:" + (s.fontSize || 16) + "px;color:" + headerColor +
        ";font-family:" + (s.fontFamily || "inherit") + ";";
      container.appendChild(title);
    }

    // Badge images
    var wrap = document.createElement("div");
    wrap.style.cssText =
      "display:flex;flex-wrap:wrap;gap:" + gap + ";justify-content:" + justify + ";";

    var badgeIds = badge.badgeIds || [];
    badgeIds.forEach(function (id) {
      var imgUrl = BADGE_IMAGE_MAP[id];
      if (!imgUrl) return;
      var img = document.createElement("img");
      img.src = imgUrl;
      img.alt = id;
      img.style.cssText =
        "width:" + badgeSize + "px;height:auto;" +
        (s.showBorder ? "border:1px solid " + (isDark ? "#555" : "#ddd") + ";" : "") +
        "border-radius:4px;";
      wrap.appendChild(img);
    });

    container.appendChild(wrap);

    // Insert at the right DOM position
    var target;
    if (pos === "above-atc") {
      target = document.querySelector(
        'form[action*="/cart/add"] button[type="submit"], .product-form__submit, [name="add"]'
      );
      if (target) target.parentNode.insertBefore(container, target);
    } else if (pos === "below-atc") {
      target = document.querySelector(
        'form[action*="/cart/add"], .product-form'
      );
      if (target) target.parentNode.insertBefore(container, target.nextSibling);
    } else if (pos === "below-description") {
      target = document.querySelector(
        '.product__description, .product-single__description, [class*="product-description"], .product__meta'
      );
      if (target) target.parentNode.insertBefore(container, target.nextSibling);
    } else if (pos === "cart-page") {
      target = document.querySelector(
        '.cart__footer, .cart-footer, form[action="/cart"]'
      );
      if (target) target.parentNode.insertBefore(container, target);
      else {
        var main = document.querySelector("main, #MainContent, .main-content");
        if (main) main.appendChild(container);
      }
    }
  }

  /* ===================== PRODUCT BADGES ===================== */

  // Shared position & shape maps
  // Explicitly set opposing axis to "auto" so Dawn's .media > * { top:0; left:0 }
  // doesn't combine with our bottom/right values and stretch the badge to full height/width.
  var POS_STYLES = {
    "top-left":     "top:8px;left:8px;bottom:auto;right:auto;",
    "top-right":    "top:8px;right:8px;bottom:auto;left:auto;",
    "bottom-left":  "bottom:8px;left:8px;top:auto;right:auto;",
    "bottom-right": "bottom:8px;right:8px;top:auto;left:auto;",
  };
  var SHAPE_STYLES = {
    circle: "border-radius:50%;width:48px;height:48px;",
    rectangle: "border-radius:4px;padding:4px 10px;",
    ribbon: "border-radius:0 4px 4px 0;padding:4px 12px 4px 8px;",
    star: "border-radius:4px;width:48px;height:48px;clip-path:polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%);",
    square: "border-radius:2px;width:48px;height:48px;",
  };

  // Check if a badge should display on this page
  function badgeShowOnPage(badge, currentPage) {
    var pages = badge.pages;
    if (!pages || pages.length === 0) return true;
    if (pages.indexOf("all") !== -1) return true;
    return pages.indexOf(currentPage) !== -1;
  }

  // Check schedule
  function badgeInSchedule(badge) {
    var s = badge.schedule;
    if (!s || (!s.startDate && !s.endDate)) return true;
    var now = new Date();
    if (s.startDate && new Date(s.startDate) > now) return false;
    if (s.endDate && new Date(s.endDate + "T23:59:59") < now) return false;
    return true;
  }

  // Evaluate automated condition against product data
  function badgeConditionMet(badge, productData) {
    var c = badge.condition;
    if (!c || c.type === "none") return true;
    if (!productData) return c.type === "none";

    var price = productData.price || 0;
    var comparePrice = productData.compare_at_price || 0;
    var inventory = productData.inventory_quantity;
    var createdAt = productData.created_at;

    switch (c.type) {
      case "on_sale":
        return comparePrice > 0 && comparePrice > price;
      case "out_of_stock":
        return inventory !== undefined && inventory <= 0;
      case "low_stock":
        var threshold = parseInt(c.value, 10) || 10;
        return inventory !== undefined && inventory > 0 && inventory <= threshold;
      case "new_arrival":
        if (!createdAt) return false;
        var days = parseInt(c.value, 10) || 30;
        var diff = (new Date() - new Date(createdAt)) / 86400000;
        return diff <= days;
      case "discount_percent":
        if (!comparePrice || comparePrice <= price) return false;
        var pct = Math.round(((comparePrice - price) / comparePrice) * 100);
        var val = parseInt(c.value, 10) || 0;
        var op = c.operator || "greater_than";
        if (op === "greater_than") return pct > val;
        if (op === "less_than") return pct < val;
        if (op === "equal_to") return pct === val;
        if (op === "between") {
          var parts = String(c.value).split("-");
          return pct >= parseInt(parts[0], 10) && pct <= parseInt(parts[1], 10);
        }
        return false;
      case "price_range":
        var range = String(c.value).split("-");
        var min = parseFloat(range[0]) || 0;
        var max = parseFloat(range[1]) || Infinity;
        return price >= min && price <= max;
      case "inventory_count":
        if (inventory === undefined) return false;
        var cnt = parseInt(c.value, 10) || 0;
        var iop = c.operator || "less_than";
        if (iop === "less_than") return inventory < cnt;
        if (iop === "greater_than") return inventory > cnt;
        if (iop === "equal_to") return inventory === cnt;
        return false;
      default:
        return true;
    }
  }

  // Replace dynamic text placeholders with product data
  function resolveDynamicText(text, productData) {
    if (!productData) return text;
    var p = productData;
    var discount = 0;
    if (p.compare_at_price && p.compare_at_price > p.price) {
      discount = Math.round(((p.compare_at_price - p.price) / p.compare_at_price) * 100);
    }
    return text
      .replace(/\{\{discount\}\}/g, String(discount))
      .replace(/\{\{inventory\}\}/g, String(p.inventory_quantity || 0))
      .replace(/\{\{sold\}\}/g, String(p.sold || 0))
      .replace(/\{\{price\}\}/g, "$" + (p.price || 0).toFixed(2))
      .replace(/\{\{compare_price\}\}/g, "$" + (p.compare_at_price || 0).toFixed(2));
  }

  // Per-product data cache keyed by handle — avoids duplicate fetches for same product
  var _productDataCache = {};
  // In-flight fetch queue — prevents duplicate simultaneous requests for same handle
  var _productFetchQueue = {};

  // Parse a raw Shopify product API response into a normalized object
  // Sum inventory across all tracked variants. For multi-variant products
  // (e.g. sizes × colors) variant[0]'s count is usually much smaller than
  // the total — using only the first variant made conditions like
  // "inventory > 300" fail on products that actually have plenty of stock.
  // Returns undefined when no variant exposes inventory data, so condition
  // checks can distinguish "untracked" from "zero".
  function _sumVariantInventory(variants) {
    if (!variants || !variants.length) return undefined;
    var total = 0;
    var anyTracked = false;
    for (var i = 0; i < variants.length; i++) {
      var q = variants[i] && variants[i].inventory_quantity;
      if (q !== null && q !== undefined && !isNaN(q)) {
        total += q;
        anyTracked = true;
      }
    }
    return anyTracked ? total : undefined;
  }

  // DOM fallback for inventory. Shopify's public /products/{handle}.json
  // hides inventory_quantity on most stores (variant.inventory_quantity =
  // undefined). However the theme often renders inventory totals into the
  // DOM via Liquid — themes like the AI grid block expose `data-inventory`
  // on the card root, ShineTrust embeds a `data-variants` JSON containing
  // per-variant inventory, etc. Walk up from the img to find any of these
  // hints.
  function getInventoryFromDOM(img) {
    if (!img) return undefined;
    // Walk up looking for the card-level container
    var card = img.closest(
      '[data-inventory], [data-product-card], [data-product-id], [data-product-handle], ' +
      '[class*="product-card"], [class*="ProductCard"], .card-wrapper, li, article'
    );
    if (!card) return undefined;

    // 1. card has data-inventory directly (AI grid block, some custom themes)
    var direct = card.getAttribute && card.getAttribute("data-inventory");
    if (direct != null && direct !== "" && !isNaN(parseInt(direct, 10))) {
      return parseInt(direct, 10);
    }

    // 2. ShineTrust pattern — JSON of variants with inventory_quantity
    var stEl = card.querySelector("[data-variants]");
    if (stEl) {
      try {
        var variantsObj = JSON.parse(stEl.getAttribute("data-variants") || "{}");
        var total = 0;
        var found = false;
        for (var k in variantsObj) {
          if (!Object.prototype.hasOwnProperty.call(variantsObj, k)) continue;
          var q = variantsObj[k] && variantsObj[k].inventory_quantity;
          if (q !== null && q !== undefined && !isNaN(q)) {
            total += q;
            found = true;
          }
        }
        if (found) return total;
      } catch (e) {}
    }

    return undefined;
  }

  function _parseProductJson(data) {
    var p = data.product || {};
    var v = (p.variants && p.variants[0]) || {};
    return {
      id: p.id,
      handle: p.handle,
      price: parseFloat(v.price) || 0,
      compare_at_price: parseFloat(v.compare_at_price) || 0,
      inventory_quantity: _sumVariantInventory(p.variants),
      created_at: p.created_at,
      tags: (p.tags || "").split(",").map(function (t) { return t.trim(); }),
      type: p.product_type || "",
      vendor: p.vendor || "",
      sold: 0,
      collections: [],
    };
  }

  // Parse one product from /products.json bulk feed (slightly different shape
  // from the per-product endpoint — variants[].price is already a string).
  function _parseBulkProduct(p) {
    var v = (p.variants && p.variants[0]) || {};
    return {
      id: p.id,
      handle: p.handle,
      price: parseFloat(v.price) || 0,
      compare_at_price: parseFloat(v.compare_at_price) || 0,
      inventory_quantity: _sumVariantInventory(p.variants),
      created_at: p.created_at,
      tags: Array.isArray(p.tags) ? p.tags : (p.tags || "").split(",").map(function (t) { return t.trim(); }),
      type: p.product_type || "",
      vendor: p.vendor || "",
      sold: 0,
      collections: [],
    };
  }

  // Per-collection membership cache: { handle: { products: { handle1: true, ... }, loaded: bool } }.
  // Targeted-collection badges need this — Shopify's /products/{h}.json doesn't
  // return which collections a product belongs to, so we have to flip it around
  // and fetch each TARGETED collection's product list.
  var _collectionMembers = {};
  var _collectionLoading = {};
  function prefetchCollectionMembers(collectionHandle, onComplete) {
    if (!collectionHandle) { if (onComplete) onComplete(); return; }
    if (_collectionMembers[collectionHandle] && _collectionMembers[collectionHandle].loaded) {
      if (onComplete) onComplete();
      return;
    }
    if (_collectionLoading[collectionHandle]) {
      _collectionLoading[collectionHandle].push(onComplete);
      return;
    }
    _collectionLoading[collectionHandle] = [onComplete];

    // sessionStorage hot path
    try {
      var key = "__badgehq_col_" + collectionHandle;
      var cached = sessionStorage.getItem(key);
      if (cached) {
        var parsed = JSON.parse(cached);
        if (parsed && parsed.t && Date.now() - parsed.t < 5 * 60 * 1000 && parsed.p) {
          _collectionMembers[collectionHandle] = { products: parsed.p, loaded: true };
          var cbs1 = _collectionLoading[collectionHandle];
          delete _collectionLoading[collectionHandle];
          cbs1.forEach(function (cb) { if (cb) cb(); });
          return;
        }
      }
    } catch (e) {}

    var members = {};
    var page = 1;
    var MAX_PAGES = 4;
    function fetchPage() {
      fetch("/collections/" + encodeURIComponent(collectionHandle) + "/products.json?limit=250&page=" + page, { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.json() : { products: [] }; })
        .then(function (data) {
          var products = (data && data.products) || [];
          for (var i = 0; i < products.length; i++) {
            if (products[i].handle) members[products[i].handle] = true;
          }
          if (products.length === 250 && page < MAX_PAGES) {
            page++;
            fetchPage();
            return;
          }
          _collectionMembers[collectionHandle] = { products: members, loaded: true };
          try {
            sessionStorage.setItem("__badgehq_col_" + collectionHandle, JSON.stringify({ t: Date.now(), p: members }));
          } catch (e) {}
          var cbs2 = _collectionLoading[collectionHandle] || [];
          delete _collectionLoading[collectionHandle];
          cbs2.forEach(function (cb) { if (cb) cb(); });
        })
        .catch(function () {
          _collectionMembers[collectionHandle] = { products: {}, loaded: true };
          var cbs3 = _collectionLoading[collectionHandle] || [];
          delete _collectionLoading[collectionHandle];
          cbs3.forEach(function (cb) { if (cb) cb(); });
        });
    }
    fetchPage();
  }

  // Bulk-prefetch up to ~1000 products in 4 paginated calls to /products.json.
  // Pre-populates _productDataCache so subsequent per-card lookups (including
  // dynamic loads detected by the MutationObserver) are O(1) with no network.
  // Falls back gracefully — per-card fetch path still works for any handle
  // not in the bulk cache.
  //
  // Cached in sessionStorage with a 5-minute TTL so navigating between
  // collection pages doesn't re-fetch.
  var _bulkLoading = false;
  function bulkPrefetchProducts(onComplete) {
    if (window.__badgehq_bulk_done || _bulkLoading) {
      if (onComplete) onComplete();
      return;
    }
    _bulkLoading = true;

    // sessionStorage hot path
    try {
      var cached = sessionStorage.getItem("__badgehq_bulk");
      if (cached) {
        var parsed = JSON.parse(cached);
        if (parsed && parsed.t && Date.now() - parsed.t < 5 * 60 * 1000 && parsed.d) {
          for (var h in parsed.d) {
            if (!_productDataCache[h]) _productDataCache[h] = parsed.d[h];
          }
          window.__badgehq_bulk_done = true;
          _bulkLoading = false;
          if (onComplete) onComplete();
          return;
        }
      }
    } catch (e) {}

    var collected = {};
    var page = 1;
    var MAX_PAGES = 4; // 4 × 250 = 1000 products covered

    function fetchPage() {
      fetch("/products.json?limit=250&page=" + page, { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.json() : { products: [] }; })
        .then(function (data) {
          var products = (data && data.products) || [];
          for (var i = 0; i < products.length; i++) {
            var p = products[i];
            if (!p.handle) continue;
            var parsed = _parseBulkProduct(p);
            collected[p.handle] = parsed;
            // Don't overwrite a richer per-card fetch result if one happened to land first
            if (!_productDataCache[p.handle]) _productDataCache[p.handle] = parsed;
          }
          if (products.length === 250 && page < MAX_PAGES) {
            page++;
            fetchPage();
            return;
          }
          // Done — persist + notify
          try {
            sessionStorage.setItem("__badgehq_bulk", JSON.stringify({ t: Date.now(), d: collected }));
          } catch (e) {}
          window.__badgehq_bulk_done = true;
          _bulkLoading = false;
          if (onComplete) onComplete();
        })
        .catch(function () {
          // /products.json may be disabled on some stores. Per-card fetches still work.
          _bulkLoading = false;
          if (onComplete) onComplete();
        });
    }

    fetchPage();
  }

  // Server-side inventory feed prefetch. Hits our app's /api/products/inventory
  // endpoint which uses the merchant's stored Admin API token to read
  // inventory_quantity and other server-only fields (the storefront API hides
  // inventory on most stores). Merges into _productDataCache so badge
  // condition checks like "inventory > 300" work even on themes that don't
  // expose data-inventory in the DOM.
  //
  // Same architectural approach as ShineTrust's
  // /search?view=shinetrust.product-handles endpoint, just hosted on our
  // backend instead of inside the merchant's theme — no Asset API write,
  // no scope changes for the merchant, just one fetch.
  var _inventoryLoading = false;
  function bulkPrefetchInventory(onComplete) {
    if (!INVENTORY_API_URL || window.__badgehq_inventory_done || _inventoryLoading) {
      if (onComplete) onComplete();
      return;
    }
    _inventoryLoading = true;

    // sessionStorage hot path
    try {
      var cached = sessionStorage.getItem("__badgehq_inv");
      if (cached) {
        var parsed = JSON.parse(cached);
        if (parsed && parsed.t && Date.now() - parsed.t < 5 * 60 * 1000 && parsed.d) {
          for (var h in parsed.d) {
            mergeInventoryData(h, parsed.d[h]);
          }
          window.__badgehq_inventory_done = true;
          _inventoryLoading = false;
          if (onComplete) onComplete();
          return;
        }
      }
    } catch (e) {}

    fetch(INVENTORY_API_URL, { credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (body) {
        if (!body || !body.products) {
          _inventoryLoading = false;
          if (onComplete) onComplete();
          return;
        }
        var pdata = body.products;
        for (var h in pdata) {
          mergeInventoryData(h, pdata[h]);
        }
        try {
          sessionStorage.setItem("__badgehq_inv", JSON.stringify({ t: Date.now(), d: pdata }));
        } catch (e) {}
        window.__badgehq_inventory_done = true;
        _inventoryLoading = false;
        if (onComplete) onComplete();
      })
      .catch(function () {
        _inventoryLoading = false;
        if (onComplete) onComplete();
      });
  }

  // Merge inventory feed entry into _productDataCache. Creates an entry if
  // the handle isn't cached yet, otherwise enriches the existing one with
  // the inventory total. -1 sentinel from the feed means "infinite stock"
  // (continue policy variant) — rewritten to a large number so > comparisons
  // pass naturally; -2 means "untracked" — left undefined so condition
  // checks distinguish "untracked" from "zero".
  function mergeInventoryData(handle, entry) {
    if (!handle || !entry) return;
    var resolvedInv;
    if (entry.inventory === -1) resolvedInv = Number.MAX_SAFE_INTEGER;
    else if (entry.inventory === -2) resolvedInv = undefined;
    else resolvedInv = entry.inventory;

    if (_productDataCache[handle]) {
      // Enrich existing entry — only fill in fields we don't already have
      var ex = _productDataCache[handle];
      if (ex.inventory_quantity === undefined || ex.inventory_quantity === null) {
        ex.inventory_quantity = resolvedInv;
      }
      if (!ex.created_at && entry.created_at) ex.created_at = entry.created_at;
      if (!ex.tags || !ex.tags.length) ex.tags = entry.tags || [];
      if (!ex.type && entry.product_type) ex.type = entry.product_type;
      if (!ex.vendor && entry.vendor) ex.vendor = entry.vendor;
      if (!ex.price && entry.price) ex.price = entry.price;
      if (!ex.compare_at_price && entry.compare_at_price) ex.compare_at_price = entry.compare_at_price;
    } else {
      _productDataCache[handle] = {
        handle: handle,
        price: entry.price || 0,
        compare_at_price: entry.compare_at_price || 0,
        inventory_quantity: resolvedInv,
        created_at: entry.created_at || "",
        tags: entry.tags || [],
        type: entry.product_type || "",
        vendor: entry.vendor || "",
        sold: 0,
        collections: [],
      };
    }
  }

  // Fetch /products/{handle}.json with per-handle caching and in-flight deduplication.
  // Multiple simultaneous calls for the same handle queue up and all resolve together.
  function fetchProductDataByHandle(handle, callback) {
    if (_productDataCache[handle]) { callback(_productDataCache[handle]); return; }
    if (_productFetchQueue[handle]) { _productFetchQueue[handle].push(callback); return; }
    _productFetchQueue[handle] = [callback];
    fetch("/products/" + handle + ".json")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        _productDataCache[handle] = _parseProductJson(data);
        var cbs = _productFetchQueue[handle] || [];
        delete _productFetchQueue[handle];
        cbs.forEach(function (cb) { cb(_productDataCache[handle]); });
      })
      .catch(function () {
        var cbs = _productFetchQueue[handle] || [];
        delete _productFetchQueue[handle];
        cbs.forEach(function (cb) { cb(null); });
      });
  }

  // Find the product handle for a given product image.
  //
  // The naive approach is `img.closest('[class*="product-card"]')` then look
  // inside, but that breaks on themes whose IMAGE WRAPPER also has a class
  // matching the selector (e.g. AI grid blocks with `sp-product-card-media`
  // on the image container). closest() stops at the image wrapper, the
  // querySelector finds nothing inside, returns null. The actual title link
  // lives in `.ai-product-info`, a SIBLING of the image wrapper.
  //
  // Robust approach: walk up the tree level by level. At each ancestor, check
  // whether its subtree contains a /products/ link. The first ancestor whose
  // subtree contains one is the card root, and that link gives us the handle.
  function getHandleFromImg(img) {
    // Fast path: img is itself wrapped in a product link
    var direct = img.closest('a[href*="/products/"]');
    if (direct) {
      var m0 = (direct.getAttribute("href") || "").match(/\/products\/([^/?#]+)/);
      if (m0) return m0[1];
    }

    // Walk up looking for an ancestor whose SUBTREE contains a product link.
    // Stop at page boundaries so we don't inadvertently match a related-products
    // link in a totally different section.
    var STOP = { MAIN: 1, HEADER: 1, FOOTER: 1, NAV: 1, BODY: 1, HTML: 1 };
    var node = img.parentElement;
    for (var i = 0; i < 12 && node && !STOP[node.tagName]; i++) {
      var found = node.querySelector('a[href*="/products/"]');
      // Make sure the link is actually for THIS card and not a nested unrelated
      // product link (e.g. a "you may also like" inside another card).
      if (found && !found.contains(img)) {
        var href = found.getAttribute("href") || "";
        var m = href.match(/\/products\/([^/?#]+)/);
        if (m) return m[1];
      }
      node = node.parentElement;
    }

    // PDP fallback — the main product image gallery on a PDP isn't wrapped in
    // a /products/{handle} link (you're already on that product). Use the
    // page's own URL.
    var pathMatch = window.location.pathname.match(/\/products\/([^/?#]+)/);
    return pathMatch ? pathMatch[1] : null;
  }

  // Fetch product data for a given img element (works on all page types)
  function fetchProductDataForImg(img, callback) {
    // On product pages use the already-fetched global (avoids redundant fetches)
    if (window.__BADGEHQ_PRODUCT_DATA__) { callback(window.__BADGEHQ_PRODUCT_DATA__); return; }

    // On product pages, seed from current path
    var pathMatch = window.location.pathname.match(/\/products\/([^/?#]+)/);
    if (pathMatch) {
      fetchProductDataByHandle(pathMatch[1], function (data) {
        window.__BADGEHQ_PRODUCT_DATA__ = data;
        callback(data);
      });
      return;
    }

    // On collection/home pages, find the handle from the card's link
    var handle = getHandleFromImg(img);
    if (handle) { fetchProductDataByHandle(handle, callback); return; }

    callback(null);
  }

  // Check targeting using fetched product data (works on all page types).
  // Returns true if the product matches the include rule AND is not excluded.
  function badgeTargetMatch(badge, img, productData) {
    var t = badge.targeting;
    if (!t) return true;

    // Exclusion check first: if the product is in the excluded collection, hide.
    if (t.excludeCollection && t.excludeCollection.value) {
      var exMembers = _collectionMembers[t.excludeCollection.value];
      var handleForExclude = (productData && productData.handle) || getHandleFromImg(img);
      if (exMembers && exMembers.loaded) {
        if (handleForExclude && exMembers.products[handleForExclude]) return false;
      }
      // If the excluded-collection list is still loading, FAIL OPEN — show the
      // badge now rather than withhold it. A large excluded collection can take
      // many seconds / MBs to prefetch, and withholding meant the badge never
      // appeared on ANY product before the retry passes gave up. Once the list
      // lands, removeExcludedBadges() strips the badge from any product that
      // turns out to be excluded. Better a brief flash on a few excluded cards
      // than the badge missing everywhere.
    }

    if (t.type === "all") return true;

    // Use fetched product data when available (reliable on all pages)
    if (productData) {
      switch (t.type) {
        case "tag":
          return productData.tags && productData.tags.indexOf(t.value) !== -1;
        case "product_type":
          return productData.type && productData.type.toLowerCase() === (t.value || "").toLowerCase();
        case "vendor":
          return productData.vendor && productData.vendor.toLowerCase() === (t.value || "").toLowerCase();
        case "products":
          var ids = (t.value || "").split(",").map(function (s) { return s.trim(); });
          return productData.id && ids.indexOf(String(productData.id)) !== -1;
        case "collection":
          // Collections not in product JSON — fall through to DOM fallback
          break;
        default:
          return true;
      }
    }

    // Collection targeting: prefer the prefetched member list (authoritative)
    // over DOM data attributes — most themes don't annotate cards with the
    // collections they belong to, so the DOM fallback was always returning
    // "show by default" which made collection-scoped badges leak onto every
    // product on the page.
    if (t.type === "collection") {
      var members = _collectionMembers[t.value];
      if (members && members.loaded) {
        var handle = (productData && productData.handle) || getHandleFromImg(img);
        return !!(handle && members.products[handle]);
      }
      // Members not loaded yet — try DOM annotation, otherwise withhold the
      // badge until the prefetch completes (a re-attach pass will pick it up).
      var card = img.closest("[data-product-collection], [data-collections]");
      if (card) {
        var cols = (card.getAttribute("data-product-collection") ||
                    card.getAttribute("data-collections") || "").split(",");
        return cols.indexOf(t.value) !== -1;
      }
      return false;
    }

    // No data at all — show by default so badges aren't silently hidden
    return true;
  }

  // Emit one <style> tag carrying @media (max-width: 749px) rules so that
  // each badge gets its mobile font size at small viewports. The badge's
  // inline `font-size` style still applies on desktop; this rule overrides
  // on mobile via a higher-specificity class selector + !important.
  // Idempotent — replaces the existing block on every call.
  function injectMobileFontSizeStyles(badges) {
    var rules = [];
    for (var i = 0; i < badges.length; i++) {
      var b = badges[i];
      var desk = parseInt(b.fontSize, 10) || 11;
      var mob = parseInt(b.fontSizeMobile, 10);
      if (!isFinite(mob)) mob = desk;
      // Skip when mobile size matches desktop — no rule needed
      if (mob === desk) continue;
      rules.push(".badgehq-pb-" + b.id + "{font-size:" + mob + "px !important;}");
    }
    var existing = document.getElementById("badgehq-mobile-font-styles");
    if (rules.length === 0) {
      if (existing) existing.remove();
      return;
    }
    var css = "@media (max-width: 749px) {" + rules.join("") + "}";
    if (existing) {
      existing.textContent = css;
    } else {
      var style = document.createElement("style");
      style.id = "badgehq-mobile-font-styles";
      style.textContent = css;
      document.head.appendChild(style);
    }
  }

  // Main product badges orchestrator — handles multi-badge, conditions, scheduling, pages
  function renderProductBadges(badges, currentPage) {
    // Filter badges by page and schedule first
    var eligible = badges.filter(function (b) {
      return badgeShowOnPage(b, currentPage) && badgeInSchedule(b);
    });
    if (eligible.length === 0) return;

    // Emit a <style> block with mobile font-size overrides per badge.
    // Inline styles can't carry media queries, so per-badge mobile sizing
    // requires a real stylesheet rule keyed by the badge's class.
    injectMobileFontSizeStyles(eligible);

    // Kick off prefetch for every collection any eligible badge targets OR
    // excludes, then re-run findAndAttach once each one lands so badges that
    // were "waiting" for membership data render (or get hidden) in place.
    var collectionsToPrefetch = {};
    for (var ei = 0; ei < eligible.length; ei++) {
      var et = eligible[ei].targeting;
      if (et && et.type === "collection" && et.value) {
        collectionsToPrefetch[et.value] = true;
      }
      if (et && et.excludeCollection && et.excludeCollection.value) {
        collectionsToPrefetch[et.excludeCollection.value] = true;
      }
    }
    Object.keys(collectionsToPrefetch).forEach(function (collectionHandle) {
      prefetchCollectionMembers(collectionHandle, function () {
        // Each collection's data lands independently; re-attach so any cards
        // that are now resolvable get their badge.
        if (typeof findAndAttach === "function") findAndAttach();
        // We FAIL OPEN while an excluded-collection list loads (so the badge
        // isn't starved by a slow/large prefetch). Once it lands, strip the
        // badge back off any card whose product is actually in the excluded set.
        removeExcludedBadges();
      });
    });

    // Remove already-attached image badges from products in a badge's
    // excludeCollection, after that list has loaded. Each badge element carries
    // the class badgehq-pb-<id>; we resolve its card's product handle from the
    // card's product image and drop it if excluded.
    function removeExcludedBadges() {
      eligible.forEach(function (badge) {
        var t = badge.targeting;
        if (!t || !t.excludeCollection || !t.excludeCollection.value) return;
        var ex = _collectionMembers[t.excludeCollection.value];
        if (!ex || !ex.loaded) return;
        var els = document.querySelectorAll(".badgehq-pb-" + badge.id);
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          // Find the card root, then its product image, then the handle.
          var card = el.closest("[class*='card'], [class*='product'], li, article") || el.parentElement;
          var cardImg = card && card.querySelector("img");
          var handle = cardImg ? getHandleFromImg(cardImg) : null;
          if (handle && ex.products[handle]) {
            // Remove the badge; if its corner stack is now empty, drop that too.
            var stack = el.parentElement;
            el.remove();
            if (stack && stack.children.length === 0 && /badgehq/.test(stack.className || "")) stack.remove();
          }
        }
      });
    }

    // Selectors covering Dawn, Debut, Broadcast, Impulse and other popular themes
    var SELECTORS = [
        ".product-card img",
        ".product-card-wrapper img",
        ".card__media img",
        ".card-product__image img",
        ".product__media img",
        ".product-media-container img",
        ".grid-product__image",
        ".product-image-container img",
        ".product-item__image img",
        ".product-grid-item img",
        '[class*="product-card"] img',
        '[class*="ProductCard"] img',
        '[class*="product-image"] img',
        'a[href*="/products/"] img',
      ].join(",");

      function attachBadges(img) {
        // Skip images inside navigation/header — they flash briefly then nav JS hides them
        if (img.closest("header, nav, .site-header, .site-nav, [role='navigation'], #site-nav, #header")) return;

        // Skip hidden images (display:none parent). offsetWidth is reliable for Dawn theme
        // which uses position:absolute + padding-bottom aspect ratio (offsetHeight is 0 there).
        if (img.offsetWidth === 0) return;

        // Lazy-load handling: Dawn (and most themes) use loading="lazy" on product
        // card images. Below-the-fold imgs aren't img.complete during the 1s/2.5s/6s
        // findAndAttach passes, so they were silently skipped — and the
        // MutationObserver doesn't fire on img-load events (only DOM tree mutations),
        // so once they did load there was no retry. Listen for the load event once
        // per pending img and re-call attachBadges when it fires.
        if (!img.complete || img.naturalWidth <= 1) {
          if (!img.__badgehqPendingLoad) {
            img.__badgehqPendingLoad = true;
            var onLoad = function () {
              img.removeEventListener("load", onLoad);
              img.removeEventListener("error", onError);
              img.__badgehqPendingLoad = false;
              attachBadges(img);
            };
            var onError = function () {
              img.removeEventListener("load", onLoad);
              img.removeEventListener("error", onError);
              img.__badgehqPendingLoad = false;
            };
            img.addEventListener("load", onLoad);
            img.addEventListener("error", onError);
          }
          return;
        }

        // Fetch per-card product data (works on all page types — home, collection, product)
        fetchProductDataForImg(img, function (productData) {
          renderBadgesOnImg(img, productData);
        });
      }

      // Find the info-area insertion point for the product card containing `img`.
      // Returns { target, mode } where mode is 'before' | 'after' | 'append', or null.
      //
      // Strategy: don't trust class-name heuristics — they trip on BEM children like
      // `card__media`. Instead, walk up and ask each ancestor "do you contain a
      // price element?". The smallest ancestor that says yes IS the card root.
      function findInfoInsertionPoint(img) {
        // Outer-wrapper-first ordering: insert badge BEFORE the entire price
        // block, not inside it. Inserting before .price__regular (a child of
        // .price__container) would land the badge between flex siblings and
        // misalign the regular/sale price layout in Dawn-derived themes.
        var PRICE_SELECTORS = [
          // Theme-specific outer wrappers
          ".product-card__price",
          ".product-item__price",
          ".grid-product__price",
          ".card__price",
          "[class*='ProductPrice']",
          "[class*='product-price']",
          "[data-product-price]",
          // Dawn outer .price — exclude its BEM children so we don't grab the inner ones first
          ".price:not(.price__container):not(.price__regular):not(.price__sale):not(.price-item):not([class*='regular-label'])",
          ".money:not(.money__compare):not([class*='compare'])",
          // Inner Dawn price elements — fallback if outer wrapper isn't matched
          ".price__regular",
          ".price-item--regular",
          // Last-resort generic
          "[class*='price']:not([class*='compare']):not([class*='label'])",
        ];
        var TITLE_SELECTORS = [
          ".card__heading",
          ".product-card__title",
          ".product-item__title",
          ".grid-product__title",
          ".card-information",
          ".card__information",
          ".product-card__info",
          ".product-item__info",
          "h2 a[href*='/products/']",
          "h3 a[href*='/products/']",
          "a[href*='/products/']",
        ];
        // Stop walking up at major page boundaries — we don't want to find the
        // PDP main price or some unrelated price in a header/footer.
        var STOP_TAGS = { MAIN: 1, HEADER: 1, FOOTER: 1, NAV: 1, FORM: 1, BODY: 1, HTML: 1 };

        function findIn(root, selectors) {
          for (var i = 0; i < selectors.length; i++) {
            var el = root.querySelector(selectors[i]);
            if (el && el.offsetWidth > 0 && el !== img && !el.contains(img)) return el;
          }
          return null;
        }

        // Pass 1: walk up looking for an ancestor that contains a price.
        var node = img.parentElement;
        var lastSafe = null;
        for (var i = 0; i < 12 && node && !STOP_TAGS[node.tagName]; i++) {
          var p = findIn(node, PRICE_SELECTORS);
          if (p) return { target: p, mode: "before" };
          lastSafe = node;
          node = node.parentElement;
        }

        // Pass 2: same walk, looking for a title — insert badge AFTER it.
        node = img.parentElement;
        for (var j = 0; j < 12 && node && !STOP_TAGS[node.tagName]; j++) {
          var t = findIn(node, TITLE_SELECTORS);
          if (t) return { target: t, mode: "after" };
          node = node.parentElement;
        }

        // Pass 3: append at the last safe ancestor (just inside any page boundary).
        if (lastSafe) return { target: lastSafe, mode: "append" };
        return null;
      }

      // Get-or-create a flex stack for image-placement badges at one corner of a
      // container. Multiple badges with the same position share one stack; the
      // stack handles the absolute positioning, individual badges are inline
      // children and flow within the stack with `gap`.
      function getOrCreateCornerStack(container, position) {
        var stackClass = "badgehq-corner-stack-" + position;
        for (var i = 0; i < container.children.length; i++) {
          if (container.children[i].classList.contains(stackClass)) return container.children[i];
        }
        var stack = document.createElement("div");
        stack.className = stackClass + " badgehq-corner-stack";
        var direction = position.indexOf("bottom") === 0 ? "column-reverse" : "column";
        var align = position.indexOf("right") !== -1 ? "flex-end" : "flex-start";
        stack.style.cssText =
          "position:absolute;z-index:10;display:flex;flex-direction:" + direction + ";gap:4px;align-items:" + align + ";pointer-events:none;" +
          (POS_STYLES[position] || POS_STYLES["top-left"]);
        container.appendChild(stack);
        return stack;
      }

      // Get-or-create a wrapper for info-area badges anchored to a price/title
      // target. All info badges for a card share one wrapper inserted at the
      // right insertion point; new ones append into it instead of stacking
      // directly before/after the target.
      function getOrCreateInfoWrapper(spot) {
        var existing = null;
        if (spot.mode === "before") {
          existing = spot.target.previousElementSibling;
          if (existing && existing.classList && existing.classList.contains("badgehq-info-stack")) return existing;
          existing = null;
        } else if (spot.mode === "after") {
          existing = spot.target.nextElementSibling;
          if (existing && existing.classList && existing.classList.contains("badgehq-info-stack")) return existing;
          existing = null;
        } else {
          for (var i = 0; i < spot.target.children.length; i++) {
            if (spot.target.children[i].classList.contains("badgehq-info-stack")) { existing = spot.target.children[i]; break; }
          }
          if (existing) return existing;
        }
        var wrap = document.createElement("div");
        wrap.className = "badgehq-info-stack";
        wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;margin:4px 0;";
        if (spot.mode === "before") spot.target.parentNode.insertBefore(wrap, spot.target);
        else if (spot.mode === "after") spot.target.parentNode.insertBefore(wrap, spot.target.nextSibling);
        else spot.target.appendChild(wrap);
        return wrap;
      }

      // True if a stack/wrapper already contains a badge with this id. Source of
      // truth for "this badge is already rendered for this card" — works across
      // multi-image cards (Dawn's main + hover image both walk up to the same
      // container and share one stack).
      function stackHasBadge(stackOrWrap, badgeId) {
        return !!stackOrWrap.querySelector(".badgehq-pb-" + badgeId);
      }

      function renderBadgesOnImg(img, productData) {
        // If the API didn't expose inventory (Shopify hides it on many
        // stores' /products/{handle}.json), pull it from the DOM. The
        // theme often renders inventory server-side via Liquid into a
        // data-inventory attribute or data-variants JSON.
        if (productData && (productData.inventory_quantity === undefined || productData.inventory_quantity === null)) {
          var domInv = getInventoryFromDOM(img);
          if (domInv !== undefined) productData.inventory_quantity = domInv;
        }

        eligible.forEach(function (badge) {
          // Targeting + condition checks run BEFORE any stack creation so we
          // don't pollute the DOM with empty wrappers for non-matching products.
          // No img-level dedup attribute — stack-presence (stackHasBadge) is the
          // source of truth, and skipping the attr lets badges that "wait" for
          // async data (like collection prefetch) render correctly when a retry
          // pass fires after the data lands.
          if (!badgeTargetMatch(badge, img, productData)) return;
          if (!badgeConditionMet(badge, productData)) return;

          // Info-area placement: render in the product info area, NOT on the image.
          // Respects merchant choice — does not fall through to image placement on failure.
          if (badge.placement === "info") {
            var spot = findInfoInsertionPoint(img);
            if (!spot) {
              if (window.console && console.warn) {
                console.warn("[BadgeHQ] info-area placement: no card ancestor found for image — badge skipped. Theme may need a custom selector.", img);
              }
              return;
            }

            var wrap = getOrCreateInfoWrapper(spot);
            // Skip if this badge id is already in the wrapper (multi-image cards
            // would otherwise add it once per image).
            if (stackHasBadge(wrap, badge.id)) return;

            var infoEl;
            if (badge.badgeType === "image" && badge.imageUrl) {
              infoEl = document.createElement("img");
              infoEl.src = badge.imageUrl;
              infoEl.alt = badge.text || "Badge";
              infoEl.style.cssText =
                "display:inline-block;max-width:80px;height:auto;pointer-events:none;" +
                "opacity:" + (badge.opacity || 1) + ";" +
                (badge.rotation ? "transform:rotate(" + badge.rotation + "deg);" : "") +
                (badge.customCSS || "");
            } else {
              infoEl = document.createElement("div");
              var bg = badge.gradient ? "background:" + badge.gradient + ";" : "background:" + badge.badgeColor + ";";
              infoEl.style.cssText =
                "display:inline-flex;align-items:center;justify-content:center;padding:4px 8px;" +
                bg +
                "color:" + badge.textColor + ";" +
                "font-size:" + (badge.fontSize || 11) + "px;font-weight:700;line-height:1;" +
                "width:auto;height:auto;max-width:max-content;white-space:nowrap;box-sizing:border-box;pointer-events:none;" +
                "opacity:" + (badge.opacity || 1) + ";" +
                (badge.rotation ? "transform:rotate(" + badge.rotation + "deg);" : "") +
                (badge.borderWidth ? "border:" + badge.borderWidth + "px solid " + (badge.borderColor || "#000") + ";" : "") +
                (SHAPE_STYLES[badge.shape] || SHAPE_STYLES["rectangle"]) +
                (badge.customCSS || "");
              infoEl.textContent = badge.badgeType === "dynamic"
                ? resolveDynamicText(badge.text, productData)
                : badge.text;
            }
            infoEl.className = "badgehq-product-badge badgehq-pb-" + badge.id;
            wrap.appendChild(infoEl);
            return;
          }

          // Walk up the DOM to find the nearest already-positioned ancestor.
          // NEVER modify existing element CSS — setting position:relative on a
          // static ancestor resets Dawn's padding-bottom aspect-ratio layout,
          // making images collapse to height:0 (the "images disappear" bug).
          //
          // Skip carousel-internal containers (Swiper, Slick, Owl, Glide).
          // Themes that wrap each product image in a swiper-slide would have
          // us anchor the badge to a single slide — when the user swipes to
          // another image, the badge disappears with the off-screen slide.
          // Walking past these lands us on the broader image-area container
          // which the carousel itself sits inside, so the badge stays visible
          // across slide changes.
          var CAROUSEL_INTERNAL_RE = /(^|\s)(swiper(-(slide|wrapper|container))?|slick-(slide|track|list|slider)|owl-(item|stage|stage-outer|carousel)|glide__(slide|slides|track))(\s|$)/i;
          var container = null;
          var node = img.parentElement;
          for (var i = 0; i < 10; i++) {
            if (!node || node === document.body) break;
            if (node.tagName === "PICTURE") { node = node.parentElement; continue; }
            var nodeCls = (node.className && node.className.toString()) || "";
            if (CAROUSEL_INTERNAL_RE.test(nodeCls)) { node = node.parentElement; continue; }
            if (window.getComputedStyle(node).position !== "static") { container = node; break; }
            node = node.parentElement;
          }
          // Fallback: use first non-inline block parent, set position only then
          if (!container) {
            node = img.parentElement;
            while (node && node !== document.body && (
              node.tagName === "PICTURE" ||
              window.getComputedStyle(node).display === "inline"
            )) { node = node.parentElement; }
            if (!node || node === document.body) return;
            container = node;
            container.style.position = "relative";
          }

          // Image-placement: badges with the same corner share one flex stack.
          // The stack handles positioning; individual badges are inline children.
          var cornerStack = getOrCreateCornerStack(container, badge.position);
          // Skip if this badge id is already in the stack (multi-image cards
          // walk to the same container and would otherwise add duplicates).
          if (stackHasBadge(cornerStack, badge.id)) return;

          if (badge.badgeType === "image" && badge.imageUrl) {
            var imgEl = document.createElement("img");
            imgEl.className = "badgehq-product-badge badgehq-pb-" + badge.id;
            imgEl.src = badge.imageUrl;
            imgEl.alt = badge.text || "Badge";
            imgEl.style.cssText =
              "max-width:80px;height:auto;pointer-events:none;" +
              "opacity:" + (badge.opacity || 1) + ";" +
              (badge.rotation ? "transform:rotate(" + badge.rotation + "deg);" : "") +
              (badge.customCSS || "");
            cornerStack.appendChild(imgEl);
            return;
          }

          var el = document.createElement("div");
          el.className = "badgehq-product-badge badgehq-pb-" + badge.id;

          var bgStyle = badge.gradient
            ? "background:" + badge.gradient + ";"
            : "background:" + badge.badgeColor + ";";

          el.style.cssText =
            "display:flex;align-items:center;justify-content:center;" +
            bgStyle +
            "color:" + badge.textColor + ";" +
            "font-size:" + (badge.fontSize || 11) + "px;font-weight:700;line-height:1;" +
            "width:auto;height:auto;max-width:max-content;white-space:nowrap;box-sizing:border-box;pointer-events:none;" +
            "opacity:" + (badge.opacity || 1) + ";" +
            (badge.rotation ? "transform:rotate(" + badge.rotation + "deg);" : "") +
            (badge.borderWidth ? "border:" + badge.borderWidth + "px solid " + (badge.borderColor || "#000") + ";" : "") +
            (SHAPE_STYLES[badge.shape] || SHAPE_STYLES["rectangle"]) +
            (badge.customCSS || "");

          el.textContent = badge.badgeType === "dynamic"
            ? resolveDynamicText(badge.text, productData)
            : badge.text;

          cornerStack.appendChild(el);
        });
      }

      function findAndAttach() {
        document.querySelectorAll(SELECTORS).forEach(attachBadges);
      }

      // Attach badges to any matching images inside a freshly-added subtree.
      // Used by the MutationObserver below so dynamically-loaded products
      // (infinite scroll, AJAX pagination, Depict grid swaps) get badges.
      function attachInSubtree(root) {
        if (!root || root.nodeType !== 1) return;
        if (root.tagName === "IMG" && root.matches && root.matches(SELECTORS)) {
          attachBadges(root);
        }
        if (root.querySelectorAll) {
          var imgs = root.querySelectorAll(SELECTORS);
          for (var i = 0; i < imgs.length; i++) attachBadges(imgs[i]);
        }
      }

      // Watch the DOM for newly-added product cards so badges keep working
      // through lazy scroll, "Load more" buttons, AJAX pagination, and any
      // theme that re-renders the grid client-side (Depict, Searchanise, etc.).
      // Dedup via window flag so multiple widget instances on the page share
      // one observer.
      function setupMutationObserver() {
        if (window.__badgehq_observer) return;
        var pendingNodes = [];
        var pendingFlush = false;
        function flush() {
          pendingFlush = false;
          var nodes = pendingNodes;
          pendingNodes = [];
          for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].isConnected) attachInSubtree(nodes[i]);
          }
        }
        var observer = new MutationObserver(function (mutations) {
          for (var i = 0; i < mutations.length; i++) {
            var added = mutations[i].addedNodes;
            for (var j = 0; j < added.length; j++) {
              var n = added[j];
              if (n.nodeType !== 1) continue;
              // Cheap filter: only queue subtrees that could plausibly contain a product image
              if (n.tagName === "IMG" || (n.querySelector && n.querySelector("img"))) {
                pendingNodes.push(n);
              }
            }
          }
          if (!pendingFlush && pendingNodes.length > 0) {
            pendingFlush = true;
            (window.requestAnimationFrame || function (cb) { setTimeout(cb, 16); })(flush);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        window.__badgehq_observer = observer;
      }

      // Kick off bulk product prefetch in parallel — pre-populates the per-handle
      // cache so dynamically-loaded cards (and the retries below) get instant
      // data lookups instead of one /products/{handle}.json fetch per card.
      bulkPrefetchProducts(function () {
        // After bulk completes, sweep the DOM once more — any cards that were
        // detected before the cache was warm now have data available.
        findAndAttach();
      });

      // Server-side inventory feed (Admin API-backed). Only fetched when at
      // least one eligible badge has an inventory-based condition — saves
      // a per-pageview edge request on stores that don't use inventory
      // badges, which is most of them.
      var needsInventory = eligible.some(function (b) {
        var c = b && b.condition;
        if (!c) return false;
        return c.type === "inventory_count" || c.type === "low_stock" || c.type === "out_of_stock";
      });
      if (needsInventory) {
        bulkPrefetchInventory(function () {
          findAndAttach();
        });
      }

      // Initial pass on whatever's already in the DOM, plus a few short retries
      // for theme JS (lazy-loaders, image reveal animations) that mutates after
      // first paint. The MutationObserver below covers everything after that.
      setTimeout(findAndAttach, 1000);
      setTimeout(findAndAttach, 2500);
      setTimeout(findAndAttach, 6000);
      setupMutationObserver();
  }

  /* ===================== FREE SHIPPING BAR ===================== */

  // Update bar content in-place (no DOM re-insertion) with a new cart total
  function updateFreeShippingBarContent(bar, total, currencySymbol) {
    var el = document.getElementById("badgehq-freeship-" + bar.id);
    if (!el) return;
    var c = bar.colors || {};
    var m = bar.messages || {};
    var threshold = parseFloat(bar.threshold) || 50;
    var pct = threshold > 0 ? Math.min((total / threshold) * 100, 100) : 0;
    var remaining = Math.max(threshold - total, 0).toFixed(2);
    var msg = pct >= 100
      ? (m.reached || "Free shipping unlocked!")
      : (m.below || "You're {{amount}} away from free shipping!").replace("{{amount}}", currencySymbol + remaining);
    el.innerHTML =
      '<p style="color:' + (c.text || "#333") + ';margin:0 0 8px;font-size:14px;font-weight:500;">' + msg + "</p>" +
      '<div style="background:' + (c.barBg || "#f0f0f0") + ';border-radius:10px;height:20px;overflow:hidden;width:100%;display:block;">' +
      '<div style="background:' + (c.progressBg || "#4caf50") + ";height:100%;width:" + pct + '%;border-radius:10px;transition:width 0.3s;display:block;"></div></div>';
  }

  // Listen for cart mutations and refresh the cart-driven widgets live.
  //
  // Free shipping bars and bundle offers share ONE listener on purpose: this
  // patches window.fetch, and a second patch would wrap the first, firing both
  // refreshes on every cart call and leaving no way to unwind either.
  function setupCartChangeListener(bars, page, currencySymbol, bundles) {
    var cartMutationPattern = /\/cart\/(change|add|update|clear)(\.js)?/;
    var refreshScheduled = false;

    function scheduleRefresh() {
      if (refreshScheduled) return;
      refreshScheduled = true;
      setTimeout(function () {
        refreshScheduled = false;
        fetch("/cart.js")
          .then(function (r) { return r.json(); })
          .then(function (cart) {
            var total = cart.total_price / 100;
            bars.forEach(function (bar) {
              updateFreeShippingBarContent(bar, total, currencySymbol);
            });
            if (bundles) {
              bundles.forEach(function (offer) {
                renderBundleOffer(offer, cart, page, currencySymbol);
              });
            }
          })
          .catch(function () {});
      }, 300);
    }

    // Intercept fetch (Dawn theme passes Request objects, not plain strings)
    var origFetch = window.fetch;
    window.fetch = function (url) {
      var result = origFetch.apply(this, arguments);
      var urlStr = typeof url === "string" ? url
        : (url && typeof url === "object" && url.url) ? url.url : "";
      if (urlStr && cartMutationPattern.test(urlStr)) {
        result.then(scheduleRefresh).catch(function () {});
      }
      return result;
    };

    // Intercept XHR (older themes use XHR)
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      if (typeof url === "string" && cartMutationPattern.test(url)) {
        this.addEventListener("load", scheduleRefresh);
      }
      return origOpen.apply(this, arguments);
    };

    // Listen for custom cart events fired by some themes
    document.addEventListener("cart:updated", scheduleRefresh);
    document.addEventListener("cart:refresh", scheduleRefresh);
    document.addEventListener("sections:rendered", scheduleRefresh); // Dawn sections API

    // MutationObserver fallback: watch cart total/subtotal elements for text changes
    // Catches themes that update cart price display via DOM without triggering a detectable event
    try {
      var cartTotalSelectors = [
        ".cart-subtotal__price", ".totals__subtotal-value",
        ".cart__total", ".cart-subtotal", "[data-cart-total]",
        ".cart-drawer__footer .price", ".cart__footer .price",
        // DigiFist "Release" theme (cart page + drawer)
        "[data-cart-total-price]", ".cart__summary-total-price", ".cart-drawer__total-price"
      ].join(",");
      var cartTotalEls = document.querySelectorAll(cartTotalSelectors);
      if (cartTotalEls.length > 0) {
        var observer = new MutationObserver(scheduleRefresh);
        cartTotalEls.forEach(function (el) {
          observer.observe(el, { childList: true, subtree: true, characterData: true });
        });
      }
    } catch (e) {}
  }

  function renderFreeShippingBar(bar, page, currencySymbol) {
    currencySymbol = currencySymbol || "$";
    if (!shouldShowOnPage(bar.pages, page)) return;

    // Remove any existing bar first to avoid duplicates
    var existing = document.getElementById("badgehq-freeship-" + bar.id);
    if (existing) existing.remove();

    fetch("/cart.js")
      .then(function (r) { return r.json(); })
      .then(function (cart) { render(cart.total_price / 100); })
      .catch(function () { render(0); });

    function render(total) {
      var c = bar.colors || {};
      var m = bar.messages || {};
      var threshold = parseFloat(bar.threshold) || 50;
      var pct = threshold > 0 ? Math.min((total / threshold) * 100, 100) : 0;
      var remaining = Math.max(threshold - total, 0).toFixed(2);
      var msg =
        pct >= 100
          ? (m.reached || "Free shipping unlocked!")
          : (m.below || "You're {{amount}} away from free shipping!").replace("{{amount}}", currencySymbol + remaining);

      var el = document.createElement("div");
      el.id = "badgehq-freeship-" + bar.id;
      el.style.cssText = "padding:12px 16px;text-align:center;margin:8px 0;width:100%;box-sizing:border-box;display:block;flex-shrink:0;";

      el.innerHTML =
        '<p style="color:' + (c.text || "#333") + ';margin:0 0 8px;font-size:14px;font-weight:500;">' + msg + "</p>" +
        '<div style="background:' + (c.barBg || "#f0f0f0") + ';border-radius:10px;height:20px;overflow:hidden;width:100%;display:block;">' +
        '<div style="background:' + (c.progressBg || "#4caf50") + ";height:100%;width:" + pct + '%;border-radius:10px;transition:width 0.3s;display:block;"></div></div>';

      insertBar(el, page);
    }

    function insertBar(el, pg) {
      var inserted = false;

      if (pg === "cart") {
        // Dawn uses <cart-footer> web component; also try class-based selectors
        var cartSelectors = [
          "cart-footer",
          ".cart__footer",
          ".cart-footer",
          ".cart__summary", // DigiFist "Release": bar sits right above the subtotal
          "cart-items",
          ".cart__items",
          'form[action="/cart"]'
        ];
        for (var i = 0; i < cartSelectors.length; i++) {
          var t = document.querySelector(cartSelectors[i]);
          if (t) {
            t.parentNode.insertBefore(el, t);
            inserted = true;
            break;
          }
        }
      }

      if (!inserted && pg === "product") {
        // On product page, insert above the add-to-cart form
        var prodSelectors = [
          ".product-form__buttons",
          ".product__info-container",
          'form[action*="/cart/add"]',
          ".product-form",
          ".product__info"
        ];
        for (var j = 0; j < prodSelectors.length; j++) {
          var p = document.querySelector(prodSelectors[j]);
          if (p) {
            p.parentNode.insertBefore(el, p);
            inserted = true;
            break;
          }
        }
      }

      // Final fallback: prepend to main content
      if (!inserted) {
        var main = document.querySelector("main, #MainContent, .main-content, #main-content");
        if (main) {
          main.prepend(el);
        } else {
          document.body.prepend(el);
        }
      }
    }
  }

  /* ===================== BUNDLE OFFERS ===================== */
  /**
   * "2 for Rs1299" style offers. PROMOTIONAL ONLY: the discount is a Shopify
   * automatic discount the merchant already set up, so nothing here touches a
   * price. Showing an offer we cannot honour would be worse than showing none.
   *
   * Counts qualifying UNITS, not line items: two of the same product in one line
   * is two units toward a "2 for" offer, which is exactly what a shopper expects.
   */
  function renderBundleOffers(offers, page, currencySymbol) {
    if (!offers || !offers.length) return;

    // A collection-scoped offer cannot be evaluated until its product list is
    // known: /cart.js reports handles but never collection membership. Load
    // those first, so the bar is right on its first paint rather than counting
    // zero and correcting itself a moment later.
    var pending = 0;
    var done = false;
    offers.forEach(function (o) {
      if (o.scope === "collection" && o.collectionHandle) pending++;
    });

    if (!pending) { loadCart(); return; }

    offers.forEach(function (o) {
      if (o.scope !== "collection" || !o.collectionHandle) return;
      prefetchCollectionMembers(o.collectionHandle, function () {
        if (--pending <= 0 && !done) { done = true; loadCart(); }
      });
    });

    function loadCart() {
      fetch("/cart.js")
        .then(function (r) { return r.json(); })
        .then(function (cart) { renderAll(cart); })
        .catch(function () { renderAll({ items: [] }); });
    }

    function renderAll(cart) {
      offers.forEach(function (offer) {
        renderBundleOffer(offer, cart, page, currencySymbol);
      });
    }
  }

  /**
   * Whether the product currently being viewed counts toward this offer.
   *
   * Reads the handle from the URL rather than any theme markup: /products/<h>
   * is the one thing every theme agrees on.
   */
  function bundleCurrentProductQualifies(offer) {
    var match = window.location.pathname.match(/\/products\/([^/?#]+)/);
    if (!match) return false;
    return bundleItemQualifies(offer, { handle: decodeURIComponent(match[1]), quantity: 1 });
  }

  /** Units in the cart that count toward this offer. */
  function bundleQualifyingUnits(offer, cart) {
    var items = (cart && cart.items) || [];
    var total = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (bundleItemQualifies(offer, it)) total += it.quantity || 0;
    }
    return total;
  }

  function bundleItemQualifies(offer, item) {
    if (offer.scope === "products") {
      var handles = offer.productHandles || [];
      return handles.indexOf(item.handle) !== -1;
    }
    if (offer.scope === "collection") {
      var handle = offer.collectionHandle || "";
      if (!handle) return false;
      // Membership comes from the collection's own product list, fetched once
      // and cached, because a cart line never carries its collections. An
      // unloaded list counts nothing rather than guessing: a bar that briefly
      // over-counts would promise an unlock the cart has not earned.
      var col = _collectionMembers[handle];
      if (!col || !col.loaded) return false;
      return Boolean(col.products[item.handle]);
    }
    return true; // "all"
  }

  /**
   * One stylesheet for every bundle offer, injected once.
   *
   * Inline styles were the wrong tool: themes style p and div inside cart
   * regions, and matching every property by hand meant one missed string left
   * the wrapper collapsible (which is exactly what happened). Selectors rooted
   * at the widget's own class beat theme rules on specificity, and the few
   * !important flags cover themes that use their own.
   */
  /**
   * Where the shopper goes to find a qualifying item.
   *
   * A collection-scoped offer has an obvious destination. A product-scoped one
   * points at the single product when there is only one, because sending
   * someone to a search page for one known product is worse than useless.
   * Everything else returns "" and no link is drawn: a link that lands on a
   * page full of items that do not count is worse than no link at all.
   */
  function bundleShopUrl(offer) {
    if (offer.scope === "collection" && offer.collectionHandle) {
      return "/collections/" + encodeURIComponent(offer.collectionHandle);
    }
    if (offer.scope === "products") {
      var handles = offer.productHandles || [];
      if (handles.length === 1) return "/products/" + encodeURIComponent(handles[0]);
      if (handles.length > 1) return "";
    }
    return "";
  }

  /**
   * Readable text colour for a given background.
   *
   * The button is filled with the merchant's progress colour, which they can
   * set to anything. White on a pale yellow bar would be unreadable, so the
   * label flips to near-black over light fills. Standard luminance, same rule
   * browsers and contrast tools use.
   */
  function bundleInkOn(bg) {
    var hex = String(bg || "").trim().replace("#", "");
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (!/^[0-9a-f]{6}$/i.test(hex)) return "#fff"; // named or rgb() colour: assume dark
    var r = parseInt(hex.slice(0, 2), 16) / 255;
    var g = parseInt(hex.slice(2, 4), 16) / 255;
    var b = parseInt(hex.slice(4, 6), 16) / 255;
    var lin = function (v) { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    var L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return L > 0.45 ? "#1a1a19" : "#fff";
  }

  /**
   * A pale wash of the accent, for the strip's background and border.
   *
   * Mixed toward white in sRGB rather than using rgba(), because the widget
   * can land on a dark or patterned cart surface where a translucent fill
   * would pick up whatever is behind it.
   */
  function bundleTint(hex, stronger) {
    var h = String(hex || "").trim().replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-f]{6}$/i.test(h)) return stronger ? "#e3e3e0" : "#f7f7f5";
    var mix = stronger ? 0.78 : 0.93; // how far toward white
    var ch = function (i) {
      var v = parseInt(h.slice(i, i + 2), 16);
      return Math.round(v + (255 - v) * mix);
    };
    return "rgb(" + ch(0) + "," + ch(2) + "," + ch(4) + ")";
  }

  /**
   * Thumbnails for the qualifying items already in the cart.
   *
   * Shopify's image URLs accept a size suffix, so this asks for a small one
   * rather than pulling a full-size product photo into a 40px circle.
   */
  function bundleCartImages(offer, cart, max) {
    var items = (cart && cart.items) || [];
    var out = [];
    for (var i = 0; i < items.length && out.length < Math.min(max, 3); i++) {
      if (!bundleItemQualifies(offer, items[i])) continue;
      var src = items[i].image || items[i].featured_image || "";
      if (!src) continue;
      out.push(src.replace(/(\.(?:png|jpe?g|webp|gif))(\?|$)/i, "_120x120$1$2"));
    }
    return out;
  }

  /** Merchant-authored text reaching innerHTML, so it is escaped. */
  function bundleEscape(t) {
    return String(t)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Last count shown per offer, so motion fires on change only. */
  var _bundleLastHave = {};

  function ensureBundleStyles() {
    if (document.getElementById("badgehq-bundle-css")) return;
    var style = document.createElement("style");
    style.id = "badgehq-bundle-css";
    style.textContent =
      // Card with a notched badge sitting on its top border. Accent colours are
      // set inline per offer; only structure lives here.
      // position:relative only so the notched flag can hang off the top edge.
      // z-index is deliberately auto: a value here would let this card paint
      // OVER a sticky checkout bar, and the offer must never cover the button
      // the shopper is trying to press.
      ".badgehq-bundle{position:relative !important;z-index:auto !important;display:block !important;" +
      "width:auto !important;box-sizing:border-box !important;margin:22px 0 18px !important;" +
      "padding:22px 18px 16px !important;border-radius:14px !important;border:1.5px solid !important;" +
      "text-align:left !important;float:none !important;visibility:visible !important;opacity:1 !important;" +
      "overflow:visible !important;pointer-events:auto !important;}" +

      ".badgehq-bundle__flag{position:absolute !important;z-index:1 !important;top:-14px !important;left:18px !important;" +
      "background:#fff !important;border:1.5px solid !important;border-radius:14px !important;" +
      "padding:3px 14px !important;font-size:13px !important;font-weight:600 !important;" +
      "line-height:1.4 !important;white-space:nowrap !important;}" +

      ".badgehq-bundle__row{display:flex !important;align-items:center !important;" +
      "justify-content:space-between !important;gap:12px !important;flex-wrap:wrap !important;}" +
      ".badgehq-bundle__left{display:flex !important;align-items:center !important;gap:12px !important;" +
      "min-width:0 !important;flex:1 1 200px !important;}" +

      // Overlapping thumbnails of what is actually in the cart.
      ".badgehq-bundle__pics{position:relative !important;height:40px !important;flex:none !important;}" +
      ".badgehq-bundle__pic{position:absolute !important;top:0 !important;width:40px !important;" +
      "height:40px !important;border-radius:50% !important;border:2px solid #fff !important;" +
      "object-fit:cover !important;box-sizing:border-box !important;background:#eee !important;" +
      "margin:0 !important;padding:0 !important;max-width:none !important;}" +

      ".badgehq-bundle__title{display:flex !important;align-items:center !important;gap:6px !important;" +
      "margin:0 !important;font-size:18px !important;font-weight:700 !important;line-height:1.3 !important;}" +
      ".badgehq-bundle__sub{margin:0 !important;font-size:14px !important;font-weight:600 !important;" +
      "color:#6B6B6B !important;line-height:1.3 !important;}" +
      ".badgehq-bundle__n{display:inline-block;font-weight:700;}" +
      ".badgehq-bundle--bump .badgehq-bundle__n{animation:badgehq-bundle-pop .45s cubic-bezier(.34,1.56,.64,1);}" +
      "@keyframes badgehq-bundle-pop{0%{transform:scale(1)}40%{transform:scale(1.3)}100%{transform:scale(1)}}" +

      ".badgehq-bundle__cta{flex:none !important;display:inline-flex !important;align-items:center !important;" +
      "gap:6px !important;background:#fff !important;border:1.5px solid !important;border-radius:8px !important;" +
      "padding:8px 16px !important;font-size:14px !important;font-weight:600 !important;" +
      "text-decoration:none !important;cursor:pointer !important;line-height:1.2 !important;" +
      "white-space:nowrap !important;transition:background .18s ease,transform .18s ease;}" +
      ".badgehq-bundle__cta:hover{background:#F3F3F3 !important;transform:translateY(-1px);}" +
      ".badgehq-bundle__cta:active{transform:translateY(0);}" +
      ".badgehq-bundle__cta:focus-visible{outline:2px solid currentColor;outline-offset:2px;}" +

      ".badgehq-bundle__progress{margin-top:14px !important;}" +
      ".badgehq-bundle__labels{display:flex !important;justify-content:space-between !important;" +
      "gap:8px !important;margin:0 0 6px !important;font-size:12px !important;font-weight:600 !important;}" +
      ".badgehq-bundle__track{height:8px !important;border-radius:99px !important;overflow:hidden !important;" +
      "margin:0 !important;padding:0 !important;display:block !important;width:100% !important;}" +
      ".badgehq-bundle__fill{height:100% !important;border-radius:99px !important;display:block !important;" +
      "transition:width .45s cubic-bezier(.34,1.4,.64,1);}" +

      ".badgehq-bundle--won .badgehq-bundle__title{animation:badgehq-bundle-won .6s ease;}" +
      "@keyframes badgehq-bundle-won{0%{transform:scale(1)}30%{transform:scale(1.05)}100%{transform:scale(1)}}" +

      // Mobile. The button used to wrap to its own full-width line, which
      // turned a compact card into a tall block for no gain: it is a secondary
      // action sitting beside a shorter message, so it stays on the row and
      // shrinks instead. Everything else tightens by a few pixels rather than
      // shrinking the type, which is what has to stay readable.
      "@media (max-width:599px){" +
      ".badgehq-bundle{padding:18px 12px 12px !important;margin:20px 0 14px !important;border-radius:12px !important;}" +
      ".badgehq-bundle__row{gap:10px !important;flex-wrap:nowrap !important;}" +
      ".badgehq-bundle__left{gap:10px !important;flex:1 1 auto !important;}" +
      ".badgehq-bundle__pics{height:34px !important;}" +
      ".badgehq-bundle__pic{width:34px !important;height:34px !important;}" +
      ".badgehq-bundle__title{font-size:15px !important;}" +
      ".badgehq-bundle__sub{font-size:12.5px !important;}" +
      ".badgehq-bundle__cta{padding:7px 12px !important;font-size:12.5px !important;border-radius:7px !important;}" +
      ".badgehq-bundle__progress{margin-top:10px !important;}" +
      ".badgehq-bundle__labels{font-size:11px !important;margin-bottom:5px !important;}" +
      ".badgehq-bundle__track{height:6px !important;}" +
      ".badgehq-bundle__flag{font-size:11.5px !important;padding:2px 10px !important;top:-12px !important;left:12px !important;}}" +

      // Very narrow phones: the right-hand hint is the first thing to go. The
      // bar and "1 of 2 added" already carry it, so it is the only line here
      // that repeats something.
      "@media (max-width:379px){" +
      ".badgehq-bundle__labels span:last-child{display:none !important;}" +
      ".badgehq-bundle__cta{padding:6px 10px !important;}}" +

      "@media (prefers-reduced-motion:reduce){" +
      ".badgehq-bundle--bump .badgehq-bundle__n,.badgehq-bundle--won .badgehq-bundle__title{animation:none !important;}" +
      ".badgehq-bundle__fill,.badgehq-bundle__cta{transition:none !important;}}";
    (document.head || document.documentElement).appendChild(style);
  }

  function renderBundleOffer(offer, cart, page, currencySymbol) {
    if (!shouldShowOnPage(offer.pages, page)) return;

    // On a product page a scoped offer is only relevant if THIS product counts
    // toward it. Without this, a "2 for 1299 on heels" offer appeared on every
    // sneaker in the store, promoting a deal that product cannot unlock.
    if (page === "product" && offer.scope !== "all" && !bundleCurrentProductQualifies(offer)) return;

    var existing = document.getElementById("badgehq-bundle-" + offer.id);
    if (existing) existing.remove();

    var need = parseInt(offer.quantity, 10) || 2;
    var have = bundleQualifyingUnits(offer, cart);
    var remaining = Math.max(need - have, 0);
    var pct = need > 0 ? Math.min((have / need) * 100, 100) : 0;

    var c = offer.colors || {};
    var m = offer.messages || {};
    var title = offer.title || "this offer";
    var msg = remaining === 0
      ? (m.reached || "{{title}} unlocked!")
      : (m.below || "Add {{remaining}} more to unlock {{title}}");
    msg = msg
      // Wrapped so the number can pop on its own when it changes. Escaping is
      // not a concern: this is a digit we generated, not merchant input.
      .replace(/\{\{remaining\}\}/g, '<span class="badgehq-bundle__n">' + remaining + "</span>")
      // "1 item" rather than "1 items": the offer copy is the shop's voice and
      // a plural bug there reads as carelessness.
      .replace(/\{\{items\}\}/g, remaining === 1 ? "item" : "items")
      .replace(/\{\{title\}\}/g, title)
      .replace(/\{\{quantity\}\}/g, String(need));

    if (window.location.search.indexOf("badgehq_debug=1") !== -1) {
      console.log("[badgehq bundle]", {
        title: offer.title,
        page: page,
        showProgress: offer.showProgress,
        typeofShowProgress: typeof offer.showProgress,
        need: need,
        have: have,
        scope: offer.scope,
        collectionLoaded: offer.scope === "collection"
          ? Boolean(_collectionMembers[offer.collectionHandle] && _collectionMembers[offer.collectionHandle].loaded)
          : "n/a",
      });
    }

    ensureBundleStyles();

    var accent = c.progressBg || "#6B21A8";
    var el = document.createElement("div");
    el.id = "badgehq-bundle-" + offer.id;
    el.className = "badgehq-bundle";
    el.style.borderColor = accent;
    el.style.background = bundleTint(accent);

    // The notch on the border. Merchant text, so escaped.
    var html = '<div class="badgehq-bundle__flag" style="color:' + accent + ";border-color:" + accent + '">' +
      bundleEscape(offer.flagText || "Best Offer") + "</div>";

    html += '<div class="badgehq-bundle__row"><div class="badgehq-bundle__left">';

    // Thumbnails of the QUALIFYING items already in the cart, so the shopper
    // sees their own picks rather than generic placeholders. Nothing is drawn
    // when the cart has none: two grey circles say less than no circles.
    var pics = bundleCartImages(offer, cart, need);
    if (pics.length) {
      html += '<div class="badgehq-bundle__pics" style="width:' + (40 + (pics.length - 1) * 24) + 'px">';
      for (var i = 0; i < pics.length; i++) {
        html += '<img class="badgehq-bundle__pic" src="' + bundleEscape(pics[i]) +
          '" alt="" loading="lazy" style="left:' + i * 24 + 'px;z-index:' + (pics.length - i) + '">';
      }
      html += "</div>";
    }

    html += "<div>";
    html += '<p class="badgehq-bundle__title" style="color:' + (c.text || "#1F1F1F") + '">' +
      bundleEscape(offer.title || "Bundle offer") + "</p>";
    // The live status line. The offer name is already the title directly
    // above, so repeating it here wastes the width mobile has least of.
    var subMsg = msg.replace(" to unlock " + bundleEscape(offer.title || ""), "").replace(/\s+$/, "");
    html += '<p class="badgehq-bundle__sub">' + (subMsg || msg) + "</p>";
    html += "</div></div>";

    // Only while the offer is unearned: once unlocked, pushing them to add more
    // is the wrong message, and the cart is where they should be heading.
    var shopUrl = remaining > 0 ? bundleShopUrl(offer) : "";
    if (shopUrl) {
      var linkText = offer.ctaText || "Explore";
      html += '<a class="badgehq-bundle__cta" href="' + shopUrl + '" style="color:' + (c.text || "#1F1F1F") +
        ";border-color:" + (c.text || "#1F1F1F") + '">' + bundleEscape(linkText) +
        '<span aria-hidden="true">&#8599;</span></a>';
    }
    html += "</div>";

    if (offer.showProgress) {
      var pctDone = need > 0 ? Math.min((have / need) * 100, 100) : 0;
      html += '<div class="badgehq-bundle__progress">' +
        '<div class="badgehq-bundle__labels" style="color:' + accent + '">' +
        "<span>" + have + " of " + need + " added</span>" +
        "<span>" + (remaining > 0 ? "Add " + remaining + " more to unlock" : "Offer unlocked") + "</span>" +
        "</div>" +
        '<div class="badgehq-bundle__track" style="background:' + bundleTint(accent, true) + '">' +
        '<div class="badgehq-bundle__fill" style="background:' + accent + ";width:" + pctDone + '%"></div>' +
        "</div></div>";
    }

    el.innerHTML = html;

    // Remember what this offer showed last time, so the bump fires on a real
    // change rather than on every render (the cart listener re-renders often).
    var prev = _bundleLastHave[offer.id];
    _bundleLastHave[offer.id] = have;
    if (prev !== undefined && have !== prev) {
      el.className += remaining === 0 ? " badgehq-bundle--won" : " badgehq-bundle--bump";
    }

    insertBundleEl(el, page);
  }

  /** Same placement the free shipping bar uses, which is theme-tested. */
  function insertBundleEl(el, pg) {
    var inserted = false;

    if (pg === "cart") {
      // INSIDE the theme's centred column, at the top.
      //
      // Inserting before <cart-items> looked right but put the card outside
      // that column: <cart-items> is a full-bleed section wrapper, so the card
      // spanned the whole viewport while the cart sat in a narrow centre. The
      // page-width div inside it is the element that actually defines the
      // column, so prepending there makes the card line up with the cart by
      // construction rather than by guessing a max-width.
      var host = document.querySelector(
        "cart-items .page-width, #main-cart-items .page-width, .cart .page-width, cart-items .cart__items, #main-cart-items",
      );
      if (host) {
        host.insertBefore(el, host.firstChild);
        inserted = true;
      }

      if (!inserted) {
        // No recognisable column: fall back to sitting above the items, which
        // is at least the right position even if the width is the theme's.
        var cartSelectors = [
          ".cart__items",
          'form[action="/cart"]',
          "cart-items",
          "cart-footer",
          ".cart__footer",
          ".cart__summary",
        ];
        for (var i = 0; i < cartSelectors.length; i++) {
          var t = document.querySelector(cartSelectors[i]);
          if (t) { t.parentNode.insertBefore(el, t); inserted = true; break; }
        }
      }
    }

    if (!inserted && pg === "product") {
      var prodSelectors = [".product-form__buttons", ".product__info-container", 'form[action*="/cart/add"]', ".product-form", ".product__info"];
      for (var j = 0; j < prodSelectors.length; j++) {
        var p = document.querySelector(prodSelectors[j]);
        if (p) { p.parentNode.insertBefore(el, p); inserted = true; break; }
      }
    }

    if (!inserted) {
      // Prepend, never append: appending to body would drop the card at the end
      // of the document, where a fixed checkout bar (Shiprocket/GoKwik and
      // friends pin one to the bottom) would sit straight on top of it.
      var main = document.querySelector("main, #MainContent, .main-content, #main-content");
      if (main) main.prepend(el); else document.body.prepend(el);
    }
  }

  /* ===================== STICKY ADD TO CART ===================== */
  function renderStickyCart(cart, currencySymbol) {
    if (!cart.showMobile && window.innerWidth < 768) return;
    if (!cart.showDesktop && window.innerWidth >= 768) return;

    // Dawn mounts <product-form> as a web component after initial parse —
    // delay DOM lookup so the ATC button is available.
    setTimeout(function () { mountStickyCart(cart, currencySymbol); }, 800);
    setTimeout(function () {
      if (!document.getElementById("badgehq-sticky-cart")) mountStickyCart(cart, currencySymbol);
    }, 2000);
  }

  // Get current variant unit price in currency units.
  // ShopifyAnalytics.meta reports prices in cents; product JSON uses string decimals.
  function getStickyCartUnitPrice(callback) {
    try {
      var meta = window.ShopifyAnalytics && window.ShopifyAnalytics.meta;
      if (meta && meta.product && meta.product.variants && meta.product.variants.length) {
        var variants = meta.product.variants;
        var selectedId = String(meta.selectedVariantId || variants[0].id);
        var variant = null;
        for (var i = 0; i < variants.length; i++) {
          if (String(variants[i].id) === selectedId) { variant = variants[i]; break; }
        }
        if (!variant) variant = variants[0];
        if (variant && variant.price) {
          // ShopifyAnalytics prices are in cents (integer)
          callback(parseInt(variant.price, 10) / 100);
          return;
        }
      }
    } catch (e) {}
    // Fallback: fetch from product JSON
    var pathMatch = window.location.pathname.match(/\/products\/([^/?#]+)/);
    if (pathMatch) {
      fetch("/products/" + pathMatch[1] + ".json?fields=variants")
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var v = data.product && data.product.variants && data.product.variants[0];
          callback(v ? parseFloat(v.price) || 0 : 0);
        })
        .catch(function () { callback(0); });
      return;
    }
    callback(0);
  }

  function mountStickyCart(cart, currencySymbol) {
    if (document.getElementById("badgehq-sticky-cart")) return; // already mounted

    var ATC_SELECTORS =
      'product-form button[type="submit"], ' +
      'form[action*="/cart/add"] button[type="submit"], ' +
      '.product-form__submit, button[name="add"], [data-add-to-cart]';

    // Buy controls injected by headless-checkout apps, used only when the
    // native button is missing or hidden. Ordered by how directly each one
    // adds to cart rather than jumping the shopper straight to checkout.
    var ALT_BUY_SELECTORS =
      '#gokwik-buy-now, button[name="sr-headless-button"], ' +
      '.sr-headless-checkout, .shiprocket-headless, .magic-cart-btn';

    var atcBtn = document.querySelector(ATC_SELECTORS);
    if (!atcBtn) return;

    var textColor   = cart.textColor   || "#ffffff";
    var buttonColor = cart.buttonColor || "#ffffff";
    var bgColor     = cart.bgColor     || "#000000";
    var radius      = cart.buttonRadius || "6";
    var isOutline   = cart.buttonStyle === "outline";
    // The bar has no fixed height - it is sized by its contents - so the
    // vertical padding is what actually makes it taller or shorter.
    var padY        = parseInt(cart.barPadding, 10);
    if (!(padY >= 0)) padY = 10;
    var btnBg       = isOutline ? "transparent" : buttonColor;
    var btnColor    = isOutline ? buttonColor : bgColor;
    var btnBorder   = isOutline ? "2px solid " + buttonColor : "none";

    var el = document.createElement("div");
    el.id = "badgehq-sticky-cart";
    el.style.cssText =
      "position:fixed;left:0;right:0;z-index:9998;display:none;" +
      (cart.position === "top" ? "top:0;" : "bottom:0;") +
      "background:" + bgColor + ";padding:" + padY + "px 16px;" +
      "box-shadow:0 " + (cart.position === "top" ? "2px" : "-2px") + " 8px rgba(0,0,0,0.15);";

    // Initial price text shown before async price resolves (shows formatted DOM value)
    var priceText = "";
    if (cart.showPrice !== false) {
      var priceEl = document.querySelector(
        ".price-item--regular:not(.price__compare), .price-item--sale, [data-product-price], .product__price .money"
      );
      if (priceEl) {
        var rawPrice = (priceEl.innerText !== undefined ? priceEl.innerText : priceEl.textContent) || "";
        priceText = rawPrice.trim().split(/[\n\r]+/).filter(function (l) { return l.trim(); })[0] || "";
      }
    }
    var sym = currencySymbol || "$";

    // Quantity selector HTML (syncs with product form's native qty input)
    var qtyHtml = "";
    if (cart.showQuantity !== false) {
      qtyHtml =
        '<div id="badgehq-qty-wrap" style="display:flex;align-items:center;border:1px solid ' + textColor +
        ';border-radius:' + radius + 'px;overflow:hidden;flex-shrink:0;">' +
        '<button id="badgehq-qty-minus" style="background:transparent;border:none;color:' + textColor +
        ';padding:8px 12px;cursor:pointer;font-size:16px;font-weight:700;line-height:1;">−</button>' +
        '<span id="badgehq-qty-val" style="color:' + textColor +
        ';font-size:13px;font-weight:600;min-width:24px;text-align:center;">1</span>' +
        '<button id="badgehq-qty-plus" style="background:transparent;border:none;color:' + textColor +
        ';padding:8px 12px;cursor:pointer;font-size:16px;font-weight:700;line-height:1;">+</button>' +
        "</div>";
    }

    el.innerHTML =
      '<div style="max-width:1200px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:10px;">' +
      '<div style="flex:1;min-width:0;">' +
      '<div style="color:' + textColor + ';font-size:14px;font-weight:600;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" id="badgehq-sticky-title">Product</div>' +
      (priceText ? '<div id="badgehq-sticky-price" style="color:' + textColor + ';font-size:12px;opacity:0.8;margin-top:2px;">' + priceText + "</div>" : "") +
      "</div>" +
      qtyHtml +
      '<button id="badgehq-atc-btn" style="background:' + btnBg + ";color:" + btnColor + ";border:" + btnBorder +
      ";border-radius:" + radius + "px;" +
      'padding:10px 20px;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0;">' +
      cart.buttonText + "</button></div>";

    // Set product title
    var productTitle = document.querySelector(".product__title, .product-single__title, h1.title, h1");
    if (productTitle) {
      var titleEl = el.querySelector("#badgehq-sticky-title");
      if (titleEl) {
        var rawTitle = (productTitle.innerText !== undefined ? productTitle.innerText : productTitle.textContent) || "";
        var titleText = rawTitle.trim().split(/[\n\r]+/)[0].trim();
        if (titleText) titleEl.textContent = titleText;
      }
    }

    // Wire quantity selector to product form's qty input
    var qtyInput = document.querySelector('input[name="quantity"], .quantity__input, input.qty');
    var qtyVal = el.querySelector("#badgehq-qty-val");
    var qtyMinus = el.querySelector("#badgehq-qty-minus");
    var qtyPlus = el.querySelector("#badgehq-qty-plus");
    var priceDisplay = el.querySelector("#badgehq-sticky-price");

    // Fetch unit price reliably from Shopify globals (cents/100) or product JSON
    var unitPrice = 0;
    getStickyCartUnitPrice(function (price) {
      unitPrice = price;
      // Update initial display with accurate price (replaces DOM-scraped text)
      if (priceDisplay && unitPrice > 0) {
        priceDisplay.textContent = sym + unitPrice.toFixed(2);
      }
    });

    function updatePriceDisplay(qty) {
      if (!priceDisplay || unitPrice <= 0) return;
      priceDisplay.textContent = sym + (unitPrice * qty).toFixed(2);
    }

    if (qtyMinus && qtyPlus && qtyVal) {
      qtyMinus.onclick = function () {
        var cur = parseInt(qtyVal.textContent) || 1;
        if (cur <= 1) return;
        var next = cur - 1;
        qtyVal.textContent = String(next);
        updatePriceDisplay(next);
        if (qtyInput) { qtyInput.value = String(next); qtyInput.dispatchEvent(new Event("change", { bubbles: true })); }
      };
      qtyPlus.onclick = function () {
        var cur = parseInt(qtyVal.textContent) || 1;
        var next = cur + 1;
        qtyVal.textContent = String(next);
        updatePriceDisplay(next);
        if (qtyInput) { qtyInput.value = String(next); qtyInput.dispatchEvent(new Event("change", { bubbles: true })); }
      };
    }

    el.querySelector("#badgehq-atc-btn").onclick = function () {
      // Re-query fresh — Dawn re-renders product-form on variant change,
      // which replaces the original button; stale reference does nothing.
      var freshBtn = document.querySelector(ATC_SELECTORS);
      var freshQtyInput = document.querySelector('input[name="quantity"], .quantity__input, input.qty');

      if (freshQtyInput && qtyVal) {
        freshQtyInput.value = qtyVal.textContent;
        freshQtyInput.dispatchEvent(new Event("input", { bubbles: true }));
        freshQtyInput.dispatchEvent(new Event("change", { bubbles: true }));
      }

      // Clicking a display:none button does nothing useful on themes where a
      // headless checkout has taken over the buy flow: the native button is
      // hidden by section CSS and its handler may never have been bound. Prefer
      // whichever buy control is actually rendered, falling back to the native
      // one (still correct on an ordinary theme) and then to the form itself.
      var target = null;
      if (freshBtn && !freshBtn.disabled && anchorIsRenderable(freshBtn)) {
        target = freshBtn;
      } else {
        var alts = document.querySelectorAll(ALT_BUY_SELECTORS);
        for (var ai = 0; ai < alts.length; ai++) {
          if (!alts[ai].disabled && anchorIsRenderable(alts[ai])) { target = alts[ai]; break; }
        }
        if (!target && freshBtn && !freshBtn.disabled) target = freshBtn;
      }

      if (target) {
        target.click();
      } else {
        // Last resort: submit the form directly
        var form = document.querySelector('form[action*="/cart/add"]');
        if (form) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
    };

    document.body.appendChild(el);

    // A hidden anchor can never "scroll out of view", so the observer that
    // normally reveals the bar would never fire and the bar would stay at its
    // initial display:none - invisible on every scroll position.
    //
    // Themes hide the native ATC button routinely: a headless checkout
    // (GoKwik, Shiprocket) replaces it with its own injected button, and the
    // original is suppressed with section CSS. Treat an unrenderable anchor as
    // "the buy button is never on screen" and just show the bar.
    function anchorIsRenderable(node) {
      if (!node) return false;
      // offsetParent is null for display:none (and for position:fixed, which
      // is why the box size is checked too rather than relying on it alone).
      var box = node.getBoundingClientRect();
      return box.width > 0 || box.height > 0;
    }

    if (cart.alwaysShow || !anchorIsRenderable(atcBtn)) {
      el.style.display = "block";
    } else {
      var observer = new IntersectionObserver(
        function (entries) {
          el.style.display = entries[0].isIntersecting ? "none" : "block";
        },
        { threshold: 0 }
      );
      observer.observe(atcBtn);

      // The anchor can be hidden AFTER mount: a variant change re-renders
      // product-form, and a headless-checkout app swaps the button in once its
      // own script loads. Re-check once things have settled so the bar does not
      // get stranded invisible by a late DOM change.
      setTimeout(function () {
        var fresh = document.querySelector(ATC_SELECTORS);
        if (!anchorIsRenderable(fresh)) {
          observer.disconnect();
          el.style.display = "block";
        }
      }, 3000);
    }
  }

  /* ===================== COUNTDOWN TIMER ===================== */
  function renderCountdownTimer(timer, page, gs) {
    if (!shouldShowOnPage(timer.pages, page)) return;

    var endDate = new Date(timer.endDate);
    if (endDate <= new Date()) return;

    var c = timer.colors || {};
    var m = timer.messages || {};

    // Idempotent for the re-inject watcher.
    if (document.getElementById("badgehq-countdown-" + timer.id)) return;

    var el = document.createElement("div");
    el.id = "badgehq-countdown-" + timer.id;
    el.style.cssText =
      "background:" +
      (c.bg || "#000") +
      ";color:" +
      (c.text || "#fff") +
      ";padding:16px;text-align:center;margin:12px 0;border-radius:8px;font-family:" +
      (gs.fontFamily || "inherit") +
      ";";

    function update() {
      var now = new Date();
      var diff = endDate - now;
      if (diff <= 0) {
        el.remove();
        return;
      }

      var days = Math.floor(diff / 86400000);
      var hours = Math.floor((diff % 86400000) / 3600000);
      var mins = Math.floor((diff % 3600000) / 60000);
      var secs = Math.floor((diff % 60000) / 1000);

      var parts =
        timer.style === "compact"
          ? [
              ["Hours", String(days * 24 + hours).padStart(2, "0")],
              ["Min", String(mins).padStart(2, "0")],
              ["Sec", String(secs).padStart(2, "0")],
            ]
          : [
              ["Days", String(days).padStart(2, "0")],
              ["Hours", String(hours).padStart(2, "0")],
              ["Min", String(mins).padStart(2, "0")],
              ["Sec", String(secs).padStart(2, "0")],
            ];

      el.innerHTML =
        '<p style="margin:0 0 12px;font-size:14px;">' +
        (m.above || "") +
        "</p>" +
        '<div style="display:flex;justify-content:center;gap:8px;">' +
        parts
          .map(function (p) {
            return (
              '<div style="text-align:center;"><div style="background:' +
              (c.accent || "#e74c3c") +
              ";color:" +
              (c.text || "#fff") +
              ';padding:8px 12px;border-radius:6px;font-size:20px;font-weight:700;min-width:48px;">' +
              p[1] +
              '</div><div style="font-size:10px;margin-top:4px;opacity:0.7;">' +
              p[0] +
              "</div></div>"
            );
          })
          .join("") +
        "</div>" +
        '<p style="margin:12px 0 0;font-size:12px;opacity:0.8;">' +
        (m.below || "") +
        "</p>";
    }

    update();
    var intervalId = setInterval(function () {
      // Stop ticking if the theme wiped the element (variant-change re-render);
      // the re-inject watcher creates a fresh timer with its own interval.
      if (!el.isConnected) {
        clearInterval(intervalId);
        return;
      }
      update();
    }, 1000);

    var target = document.querySelector(
      'form[action*="/cart/add"], .product-form, main, #MainContent'
    );
    if (target)
      target.parentNode.insertBefore(el, target.nextSibling);
  }

  /* ===================== DELIVERY ESTIMATE ===================== */
  function renderDeliveryEstimate(cfg) {
    // Dawn/Release mount <product-form> as a web component after initial
    // parse, so the anchor isn't there on first tick. mountDeliveryEstimate
    // retries on its own until the anchor appears.
    mountDeliveryEstimate(cfg, 0);
  }

  // Resolve the delivery widget's insertion point for the chosen placement.
  // Returns { target, before } or null when no anchor is available yet.
  // The ATC form is the most stable anchor on Section-Rendering themes; the
  // product description lives inside <product-info> and can be an accordion,
  // so "below-description" falls back to below-ATC when it isn't found.
  function resolveDeliveryAnchor(placement) {
    if (placement === "above-atc") {
      var above = document.querySelector(".product-form__buttons, form[action*='/cart/add'], .product-form");
      return above ? { target: above, before: true } : null;
    }
    if (placement === "below-description") {
      var desc = document.querySelector(
        ".product__description, .product-single__description, [class*='product-description'], .product__meta"
      );
      if (desc) {
        // Never inject inside a collapsed accordion body — climb to the block.
        var accBody = desc.closest(".accordion__body, .accordion__body-inner");
        if (accBody && accBody.parentNode) desc = accBody.parentNode;
        return { target: desc, before: false };
      }
      // fall through to below-atc when there's no description anchor
    }
    // below-atc (default) + fallback for the cases above.
    var btns = document.querySelector(".product-form__buttons");
    if (btns) return { target: btns, before: false };
    var form = document.querySelector("form[action*='/cart/add'], .product-form");
    return form ? { target: form, before: false } : null;
  }

  function mountDeliveryEstimate(cfg, attempt) {
    cfg = cfg || {};
    attempt = attempt || 0;
    var placement = cfg.placement || "below-atc";
    var heading = cfg.heading || "Estimate delivery date";
    var deliverBy = cfg.deliverBy || "Delivery by";
    var freeDelivery = cfg.freeDelivery || "";
    var fasterNote = cfg.fasterNote || "";
    // Skip if already injected, or if the merchant placed the optional
    // "Delivery Estimate" theme app block for manual positioning.
    if (document.querySelector("[data-delivery-estimate]")) return;

    var anchor = resolveDeliveryAnchor(placement);
    if (!anchor || !anchor.target.parentNode) {
      // Anchor not in the DOM yet (late mount / mid variant-swap): retry a
      // bounded number of times before giving up.
      if (attempt < 12) {
        setTimeout(function () { mountDeliveryEstimate(cfg, attempt + 1); }, 400);
      }
      return;
    }
    var target = anchor.target;
    var insertBeforeTarget = anchor.before;

    if (!document.getElementById("badgehq-de-style")) {
      var style = document.createElement("style");
      style.id = "badgehq-de-style";
      style.textContent =
        ".badgehq-de{margin:16px 0;padding:14px 16px;border:1px solid rgba(var(--color-foreground,18 18 18),0.12);border-radius:var(--buttons-radius,6px);font-size:1.4rem;}" +
        ".badgehq-de__label{display:flex;align-items:center;gap:6px;font-weight:600;margin-bottom:10px;}" +
        ".badgehq-de__label svg{flex:none;opacity:0.75;}" +
        ".badgehq-de__form{display:flex;gap:8px;align-items:stretch;}" +
        ".badgehq-de__input{flex:1 1 auto;min-width:0;padding:10px 12px;font:inherit;font-size:1.4rem;color:rgb(var(--color-foreground,18 18 18));background:rgb(var(--color-background,255 255 255));border:1px solid rgba(var(--color-foreground,18 18 18),0.2);border-radius:var(--inputs-radius,4px);letter-spacing:0.05em;}" +
        ".badgehq-de__input:focus{outline:none;border-color:rgb(var(--color-foreground,18 18 18));}" +
        ".badgehq-de__button{flex:none;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer;color:rgb(var(--color-button-text,255 255 255));background:rgb(var(--color-button,18 18 18));border:1px solid transparent;border-radius:var(--buttons-radius,4px);}" +
        ".badgehq-de__button:disabled{opacity:0.6;cursor:default;}" +
        ".badgehq-de__result{margin-top:10px;line-height:1.4;}" +
        '.badgehq-de__result[data-de-state="idle"]{margin-top:0;}' +
        '.badgehq-de__result[data-de-state="ok"]{color:#157a3d;}' +
        '.badgehq-de__result[data-de-state="unserviceable"],.badgehq-de__result[data-de-state="error"]{color:rgb(var(--color-foreground,18 18 18));opacity:0.85;}' +
        ".badgehq-de__row{display:flex;align-items:center;gap:6px;}" +
        ".badgehq-de__row svg{flex:none;}" +
        ".badgehq-de__row+.badgehq-de__row{margin-top:4px;}" +
        ".badgehq-de__faster{color:rgb(var(--color-foreground,18 18 18));opacity:0.7;font-size:0.92em;}" +
        ".badgehq-de__result svg{vertical-align:-2px;margin-right:4px;}" +
        ".badgehq-de__result strong{font-weight:700;}" +
        ".badgehq-de-spinner{display:inline-block;width:13px;height:13px;margin-right:4px;vertical-align:-1px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:badgehq-de-spin 0.6s linear infinite;}" +
        "@keyframes badgehq-de-spin{to{transform:rotate(360deg);}}" +
        "@media (prefers-reduced-motion:reduce){.badgehq-de-spinner{animation-duration:2s;}}";
      document.head.appendChild(style);
    }

    var root = document.createElement("div");
    root.id = "badgehq-delivery-estimate";
    root.className = "badgehq-de";
    root.setAttribute("data-delivery-estimate", "");
    root.innerHTML =
      '<div class="badgehq-de__label">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z"/></svg>' +
      "<span>" + escapeDeHtml(heading) + "</span></div>" +
      '<form class="badgehq-de__form" novalidate>' +
      '<input class="badgehq-de__input" type="text" inputmode="numeric" pattern="\\d{6}" maxlength="6" autocomplete="postal-code" placeholder="Enter 6-digit PIN code" aria-label="Enter your 6-digit PIN code">' +
      '<button class="badgehq-de__button" type="submit">Check</button></form>' +
      '<div class="badgehq-de__result" data-de-state="idle" aria-live="polite"></div>';

    if (insertBeforeTarget) {
      target.parentNode.insertBefore(root, target);
    } else {
      target.parentNode.insertBefore(root, target.nextSibling);
    }

    var form = root.querySelector("form");
    var input = root.querySelector("input");
    var button = root.querySelector("button");
    var result = root.querySelector(".badgehq-de__result");
    var STORAGE_KEY = "badgehq_delivery_pin";

    function setState(state, html) {
      result.setAttribute("data-de-state", state);
      result.innerHTML = html;
    }

    function check(pin) {
      setState("loading", '<span class="badgehq-de-spinner" aria-hidden="true"></span> Checking delivery time…');
      button.disabled = true;

      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 8000);

      fetch(DELIVERY_API_URL + "&pincode=" + encodeURIComponent(pin), {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      })
        .then(function (r) {
          clearTimeout(timer);
          if (r.status === 404) throw new Error("setup-pending");
          if (!r.ok) throw new Error("bad-status");
          return r.json();
        })
        .then(function (data) {
          var html = deliveryResultHtml(data, {
            deliverBy: deliverBy,
            freeDelivery: freeDelivery,
            fasterNote: fasterNote,
          });
          if (html) {
            setState("ok", html);
          } else {
            setState("unserviceable",
              "Sorry, we don’t deliver to <strong>" + escapeDeHtml(pin) + "</strong> yet.");
          }
        })
        .catch(function (err) {
          clearTimeout(timer);
          if (err && err.message === "setup-pending") {
            // Config was disabled after the widgets payload was cached — hide.
            setState("idle", "");
            root.style.display = "none";
          } else {
            setState("error", "Couldn’t check right now. Please try again.");
          }
        })
        .finally(function () { button.disabled = false; });
    }

    // Restore the shopper's last-used PIN so they don't retype it per product.
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved && /^\d{6}$/.test(saved)) {
        input.value = saved;
        check(saved);
      }
    } catch (e) { /* private mode: ignore */ }

    input.addEventListener("input", function () {
      input.value = input.value.replace(/\D/g, "").slice(0, 6);
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var pin = input.value.trim();
      if (!/^\d{6}$/.test(pin)) {
        setState("error", "Enter a valid 6-digit PIN code.");
        input.focus();
        return;
      }
      try { localStorage.setItem(STORAGE_KEY, pin); } catch (e2) {}
      check(pin);
    });
  }

  function escapeDeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Build the "ok" result HTML from the EDD response. Returns "" when no
  // configured mode is serviceable. Shows a single "{deliverBy} {date}" row
  // using the fastest serviceable date (no standard/express labels), plus
  // optional merchant free-delivery and "faster at checkout" lines. The
  // top-level etaText path keeps old cached responses working.
  var DE_CHECK_SVG =
    '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">' +
    '<path fill="currentColor" d="M8 15.2 3.8 11l1.4-1.4L8 12.4l6.8-6.8L16.2 7 8 15.2z"/></svg>';
  var DE_TRUCK_SVG =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
    '<path fill="currentColor" d="M3 4h11v9H3V4Zm12 3h3.5L21 10v3h-6V7ZM6.5 18a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm11 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z"/></svg>';

  // Pick the earliest (fastest) serviceable entry from the modes array.
  function fastestServiceable(data) {
    if (Object.prototype.toString.call(data.modes) === "[object Array]") {
      var best = null;
      for (var i = 0; i < data.modes.length; i++) {
        var m = data.modes[i];
        if (!m || !m.serviceable || !(m.etaText || m.etaDate)) continue;
        if (!best || String(m.etaDate || "") < String(best.etaDate || "")) best = m;
      }
      if (best) return best;
    }
    if (data.serviceable && (data.etaText || data.etaDate)) {
      return { etaText: data.etaText, etaDate: data.etaDate };
    }
    return null;
  }

  function deliveryResultHtml(data, opts) {
    if (!data) return "";
    opts = opts || {};
    var best = fastestServiceable(data);
    if (!best) return "";
    var deliverBy = opts.deliverBy || "Delivery by";
    var when = best.etaText || best.etaDate;
    var html =
      '<div class="badgehq-de__row">' + DE_CHECK_SVG +
      "<span>" + escapeDeHtml(deliverBy) + " <strong>" + escapeDeHtml(when) + "</strong></span></div>";
    if (opts.freeDelivery) {
      html += '<div class="badgehq-de__row">' + DE_TRUCK_SVG +
        "<span>" + escapeDeHtml(opts.freeDelivery) + "</span></div>";
    }
    if (opts.fasterNote) {
      html += '<div class="badgehq-de__row badgehq-de__faster"><span>' +
        escapeDeHtml(opts.fasterNote) + "</span></div>";
    }
    return html;
  }

  /* ===================== ORDER MANAGEMENT (account order page) ===================== */
  // Talks to the app proxy at /apps/badgehq/order-actions. Shopify signs the
  // request and attaches logged_in_customer_id; the backend enforces that the
  // order belongs to the logged-in customer and is still unfulfilled.
  var OM_PROXY = "/apps/badgehq/order-actions";

  function renderOrderActions() {
    if (document.getElementById("badgehq-order-actions")) return;

    // A merchant-placed "Order Actions" theme block gives us an explicit
    // mount point and can carry the order name directly (Liquid: order.name).
    var placedBlock = document.querySelector("[data-badgehq-order-actions]");

    // Find the order name ("#172138"): the placed block's attribute first,
    // then the page heading, then the document title.
    var name = placedBlock && placedBlock.getAttribute("data-order-name");
    name = name && name.trim();
    if (!name) {
      var headings = document.querySelectorAll("h1, h2");
      for (var i = 0; i < headings.length; i++) {
        var m = headings[i].textContent.match(/#[\w-]+/);
        if (m) { name = m[0]; break; }
      }
    }
    if (!name) {
      var t = (document.title || "").match(/#[\w-]+/);
      if (t) name = t[0];
    }
    if (!name) return;

    fetch(OM_PROXY + "?name=" + encodeURIComponent(name), {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (info) {
        if (!info || !info.enabled) return;
        // Render whenever the merchant allows cancellation — even if this
        // specific order can't be cancelled (cancelled/fulfilled/prepaid), so
        // the button shows greyed-out with the reason instead of vanishing.
        if (!info.allowCancel && !info.cancellable && !info.addressEditable) return;
        mountOrderActions(name, info, placedBlock);
      })
      .catch(function () { /* proxy unreachable — stay silent */ });
  }

  function mountOrderActions(name, info, placedBlock) {
    if (document.getElementById("badgehq-order-actions")) return;

    if (!document.getElementById("badgehq-om-style")) {
      var style = document.createElement("style");
      style.id = "badgehq-om-style";
      style.textContent =
        ".badgehq-om{margin:20px 0;padding:16px;border:1px solid rgba(0,0,0,0.12);border-radius:8px;max-width:520px;}" +
        ".badgehq-om h3{margin:0 0 12px;font-size:1.1em;}" +
        ".badgehq-om__row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px;}" +
        ".badgehq-om__btn{padding:10px 18px;font:inherit;font-weight:600;cursor:pointer;border-radius:6px;border:1px solid transparent;}" +
        ".badgehq-om__btn--danger{color:#fff;background:#c62828;}" +
        ".badgehq-om__btn--secondary{color:inherit;background:transparent;border-color:rgba(0,0,0,0.35);}" +
        ".badgehq-om__btn:disabled{opacity:0.6;cursor:default;}" +
        ".badgehq-om__msg{margin:8px 0 0;line-height:1.4;}" +
        ".badgehq-om__msg--ok{color:#157a3d;}" +
        ".badgehq-om__msg--err{color:#c62828;}" +
        ".badgehq-om__form{display:none;margin-top:12px;}" +
        ".badgehq-om__form.is-open{display:block;}" +
        ".badgehq-om__grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}" +
        ".badgehq-om__grid .full{grid-column:1 / -1;}" +
        ".badgehq-om__form input{width:100%;box-sizing:border-box;padding:9px 10px;font:inherit;border:1px solid rgba(0,0,0,0.25);border-radius:5px;}" +
        ".badgehq-om__form label{display:block;font-size:0.85em;margin:0 0 3px;opacity:0.8;}" +
        ".badgehq-om__form .badgehq-om__row{margin-top:10px;}";
      document.head.appendChild(style);
    }

    var root = document.createElement("div");
    root.id = "badgehq-order-actions";
    root.className = "badgehq-om";

    var a = info.shippingAddress || {};
    function field(id, label, value, full) {
      return (
        '<div class="' + (full ? "full" : "") + '"><label for="badgehq-om-' + id + '">' + label + "</label>" +
        '<input id="badgehq-om-' + id + '" name="' + id + '" value="' + escapeDeHtml(value || "") + '"></div>'
      );
    }

    // Label for the disabled state, by reason.
    var disabledLabel = "Cancel order";
    if (info.reason === "cancelled") disabledLabel = "Order cancelled";
    else if (info.reason === "fulfilled") disabledLabel = "Cancel unavailable";

    var html = "<h3>Manage this order</h3>";
    html += '<div class="badgehq-om__row">';
    if (info.cancellable) {
      html += '<button type="button" class="badgehq-om__btn badgehq-om__btn--danger" data-om-cancel>Cancel order</button>';
    } else if (info.allowCancel) {
      // Show the button greyed-out/disabled rather than hiding it, so the
      // customer sees the action exists but isn't available for this order.
      html +=
        '<button type="button" class="badgehq-om__btn badgehq-om__btn--danger" disabled ' +
        'aria-disabled="true" title="' + escapeDeHtml(disabledLabel) + '">' +
        escapeDeHtml(disabledLabel) + "</button>";
    }
    if (info.addressEditable) {
      html += '<button type="button" class="badgehq-om__btn badgehq-om__btn--secondary" data-om-edit>Edit shipping address</button>';
    }
    html += "</div>";
    if (!info.cancellable && info.reason === "prepaid") {
      html += '<p class="badgehq-om__msg">This order is prepaid — please contact us to cancel it.</p>';
    } else if (!info.cancellable && info.reason === "fulfilled") {
      html += '<p class="badgehq-om__msg">This order has been shipped and can no longer be cancelled.</p>';
    } else if (!info.cancellable && info.reason === "cancelled") {
      html += '<p class="badgehq-om__msg">This order has already been cancelled.</p>';
    }
    if (info.addressEditable) {
      html +=
        '<form class="badgehq-om__form" data-om-form><div class="badgehq-om__grid">' +
        field("firstName", "First name", a.firstName) +
        field("lastName", "Last name", a.lastName) +
        field("address1", "Address line 1", a.address1, true) +
        field("address2", "Address line 2", a.address2, true) +
        field("city", "City", a.city) +
        field("province", "State", a.province) +
        field("zip", "PIN / ZIP code", a.zip) +
        field("phone", "Phone", a.phone) +
        "</div>" +
        '<div class="badgehq-om__row"><button type="submit" class="badgehq-om__btn badgehq-om__btn--danger">Save address</button></div>' +
        "</form>";
    }
    html += '<div class="badgehq-om__msg" data-om-msg aria-live="polite"></div>';
    root.innerHTML = html;

    // If the merchant placed the theme block, render inside it (exact
    // position they chose). Otherwise auto-place after the order heading.
    if (placedBlock) {
      placedBlock.innerHTML = "";
      placedBlock.appendChild(root);
    } else {
      var h = document.querySelector("h1");
      if (h && h.parentNode) {
        h.parentNode.insertBefore(root, h.nextSibling);
      } else {
        var main = document.querySelector("main, #MainContent");
        if (main) main.prepend(root);
        else return;
      }
    }

    var msgEl = root.querySelector("[data-om-msg]");
    function setMsg(kind, text) {
      msgEl.className = "badgehq-om__msg" + (kind ? " badgehq-om__msg--" + kind : "");
      msgEl.textContent = text;
    }

    function post(params, button, okText) {
      button.disabled = true;
      setMsg("", "Please wait…");
      params.set("name", name);
      fetch(OM_PROXY, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        credentials: "same-origin",
        body: params.toString(),
      })
        .then(function (r) { return r.json().then(function (d) { return { s: r.status, d: d }; }); })
        .then(function (res) {
          if (res.d && res.d.ok) {
            setMsg("ok", okText);
            setTimeout(function () { window.location.reload(); }, 1800);
          } else {
            var err = (res.d && res.d.error) || "Something went wrong. Please try again.";
            setMsg("err", err === "not-cancellable" ? "This order can no longer be cancelled." : err);
            button.disabled = false;
          }
        })
        .catch(function () {
          setMsg("err", "Couldn’t reach the server. Please try again.");
          button.disabled = false;
        });
    }

    var cancelBtn = root.querySelector("[data-om-cancel]");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", function () {
        if (!window.confirm("Cancel order " + name + "? This cannot be undone.")) return;
        var p = new URLSearchParams();
        p.set("intent", "cancel");
        post(p, cancelBtn, "Order cancelled. Refreshing…");
      });
    }

    var editBtn = root.querySelector("[data-om-edit]");
    var form = root.querySelector("[data-om-form]");
    if (editBtn && form) {
      editBtn.addEventListener("click", function () {
        form.classList.toggle("is-open");
      });
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var p = new URLSearchParams();
        p.set("intent", "update-address");
        var inputs = form.querySelectorAll("input");
        for (var i = 0; i < inputs.length; i++) p.set(inputs[i].name, inputs[i].value);
        post(p, form.querySelector('button[type="submit"]'), "Address updated. Refreshing…");
      });
    }
  }

  /* ===================== WISHLIST ===================== */
  // localStorage is the source of truth; logged-in customers additionally
  // sync the list (union-merged) through the app proxy at
  // /apps/badgehq/wishlist-sync. The wishlist page is served by the proxy at
  // /apps/badgehq/wishlist and rendered client-side by wlRenderPage.
  var WL_KEY = "badgehq_wishlist";
  var WL_SYNC = "/apps/badgehq/wishlist-sync";
  var WL_PAGE = "/apps/badgehq/wishlist";
  // Cross-origin, unlike WL_SYNC: this one accepts GUESTS, who never get a
  // logged_in_customer_id and so can't use the app proxy.
  var WL_EVENT = API_ORIGIN + "/api/wishlist-event";
  var wlSyncTimer = null;
  var wlCfg = null;

  function wlGet() {
    try {
      var raw = JSON.parse(localStorage.getItem(WL_KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  }
  function wlSave(handles) {
    try { localStorage.setItem(WL_KEY, JSON.stringify(handles)); } catch (e) {}
    wlOnChange();
  }
  function wlHas(handle) { return wlGet().indexOf(handle) !== -1; }

  // Meta's own first-party cookies. They are the only way to match a GUEST, who
  // never reaches the app proxy and so is invisible to the server otherwise.
  // Ad-blockers strip these for some shoppers; the event still sends and matches
  // on IP + user agent, just less precisely.
  function wlCookie(name) {
    try {
      var m = document.cookie.match("(^|;)\\s*" + name + "\\s*=\\s*([^;]+)");
      return m ? decodeURIComponent(m[2]) : "";
    } catch (e) { return ""; }
  }

  // Report a save to the server so it can be recorded for the CSV export and
  // forwarded to Meta as AddToWishlist. Fire-and-forget: the wishlist itself has
  // already been written to localStorage, so this must never block or fail it.
  function wlReportEvent(handle, action) {
    if (!SHOP) return;
    try {
      var body = {
        shop: SHOP,
        handle: handle,
        action: action,
        customerId: wlCustomerId() || "",
        fbp: wlCookie("_fbp"),
        fbc: wlCookie("_fbc"),
        pageUrl: location.href,
      };
      // Product id and price make the Meta event far more useful for retargeting
      // (it can show the exact product), but they are optional: never hold up
      // the event waiting for them.
      fetch("/products/" + encodeURIComponent(handle) + ".js", { headers: { Accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
        .then(function (p) {
          if (p) {
            body.productId = String(p.id || "");
            if (p.price != null) body.value = Number(p.price) / 100;
            body.currency = (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || "";
          }
          fetch(WL_EVENT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            keepalive: true, // survives the shopper navigating away immediately
          }).catch(function () {});
        });
    } catch (e) {}
  }

  function wlToggle(handle) {
    if (!handle) return;
    var list = wlGet();
    var i = list.indexOf(handle);
    var added = i === -1;
    if (added) list.push(handle); else list.splice(i, 1);
    wlSave(list);
    wlScheduleSync();
    // Only adds are reported to Meta: there is no "un-wishlist" event, and a
    // removal should not retarget anyone.
    if (added) wlReportEvent(handle, "add");
  }

  function wlCustomerId() {
    try {
      if (window.__st && window.__st.cid) return String(window.__st.cid);
      var meta = window.ShopifyAnalytics && window.ShopifyAnalytics.meta;
      if (meta && meta.page && meta.page.customerId) return String(meta.page.customerId);
    } catch (e) {}
    return null;
  }

  function wlScheduleSync() {
    if (!wlCustomerId()) return;
    clearTimeout(wlSyncTimer);
    wlSyncTimer = setTimeout(function () {
      var p = new URLSearchParams();
      p.set("handles", JSON.stringify(wlGet()));
      fetch(WL_SYNC, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        credentials: "same-origin",
        body: p.toString(),
      }).catch(function () { /* local copy remains authoritative */ });
    }, 2000);
  }

  function wlInitialSync() {
    if (!wlCustomerId()) return;
    fetch(WL_SYNC, { headers: { Accept: "application/json" }, credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !Array.isArray(data.handles)) return;
        var local = wlGet();
        var merged = local.slice();
        for (var i = 0; i < data.handles.length; i++) {
          if (merged.indexOf(data.handles[i]) === -1) merged.push(data.handles[i]);
        }
        if (merged.length !== local.length) wlSave(merged);
        if (merged.length !== data.handles.length) wlScheduleSync();
      })
      .catch(function () {});
  }

  // Re-render every wishlist-driven bit of UI after any change.
  function wlOnChange() {
    var count = wlGet().length;
    var bubble = document.querySelector("[data-badgehq-wl-count]");
    if (bubble) {
      bubble.textContent = String(count);
      bubble.style.display = count > 0 ? (bubble.getAttribute("data-wl-display") || "") : "none";
    }
    var hearts = document.querySelectorAll("[data-badgehq-wl-handle]");
    for (var i = 0; i < hearts.length; i++) {
      wlPaintHeart(hearts[i], wlHas(hearts[i].getAttribute("data-badgehq-wl-handle")));
    }
    var pdp = document.getElementById("badgehq-wl-product");
    if (pdp) {
      var on = wlHas(pdp.getAttribute("data-badgehq-wl-handle"));
      var label = pdp.querySelector("[data-wl-label]");
      if (label) label.textContent = on ? "Added to wishlist" : "Add to wishlist";
    }
  }

  var WL_HEART_PATH =
    '<path d="M12 21s-7.5-4.9-10-9.3C.3 8.6 2.2 5 5.7 5c2 0 3.5 1.1 4.3 2.6L12 9l2-1.4C14.8 6.1 16.3 5 18.3 5c3.5 0 5.4 3.6 3.7 6.7C19.5 16.1 12 21 12 21z"/>';

  function wlHeartSvg(filled, color, size) {
    return (
      '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" aria-hidden="true" ' +
      'fill="' + (filled ? color : "none") + '" stroke="' + color + '" stroke-width="2">' +
      WL_HEART_PATH + "</svg>"
    );
  }

  function wlPaintHeart(el, filled) {
    var svg = el.querySelector("svg");
    if (!svg) return;
    svg.setAttribute("fill", filled ? (wlCfg && wlCfg.iconColor) || "#e74c3c" : "none");
    el.setAttribute("aria-pressed", filled ? "true" : "false");
  }

  function wlHandleFromLink(el) {
    var a = el.closest ? el.closest('a[href*="/products/"]') : null;
    if (!a) {
      var scope = el.closest ? el.closest("li, article, div") : null;
      a = scope && scope.querySelector ? scope.querySelector('a[href*="/products/"]') : null;
    }
    if (!a) return null;
    var m = a.getAttribute("href").match(/\/products\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  /* --- Surface: product-card hearts --- */
  var WL_CARD_SELECTORS = [
    ".card__media",            // Dawn
    ".product-card__media",    // DigiFist Release
    ".card-product__image",
    ".grid-product__image-wrapper",
    ".product-item__image",
    '[class*="product-card"] [class*="media"]',
    ".card__inner",
  ];

  function wlDecorateCards(cfg) {
    wlCfg = cfg;
    if (!cfg.showOnCards) return;
    for (var s = 0; s < WL_CARD_SELECTORS.length; s++) {
      var wraps = document.querySelectorAll(WL_CARD_SELECTORS[s]);
      for (var i = 0; i < wraps.length; i++) {
        var wrap = wraps[i];
        if (wrap.getAttribute("data-badgehq-wl-done")) continue;
        // Skip if a nested candidate will also match (decorate innermost only once).
        if (wrap.querySelector("[data-badgehq-wl-handle]")) {
          wrap.setAttribute("data-badgehq-wl-done", "1");
          continue;
        }
        var handle = wlHandleFromLink(wrap);
        if (!handle) continue;
        wrap.setAttribute("data-badgehq-wl-done", "1");

        var cs = window.getComputedStyle(wrap);
        if (cs.position === "static") wrap.style.position = "relative";

        var btn = document.createElement("button");
        btn.type = "button";
        btn.setAttribute("data-badgehq-wl-handle", handle);
        btn.setAttribute("aria-label", "Add to wishlist");
        var corner = cfg.cardPosition === "top-left" ? "left:8px;" : "right:8px;";
        btn.style.cssText =
          "position:absolute;top:8px;" + corner +
          "z-index:4;width:34px;height:34px;padding:0;display:flex;align-items:center;justify-content:center;" +
          "background:rgba(255,255,255,0.92);border:none;border-radius:50%;cursor:pointer;" +
          "box-shadow:0 1px 4px rgba(0,0,0,0.15);";
        btn.innerHTML = wlHeartSvg(wlHas(handle), cfg.iconColor, 18);
        wlPaintHeart(btn, wlHas(handle));
        btn.addEventListener("click", function (e) {
          e.preventDefault();
          e.stopPropagation();
          wlToggle(this.getAttribute("data-badgehq-wl-handle"));
        });
        wrap.appendChild(btn);
      }
    }
  }

  /* --- Surface: product-page button --- */
  function wlMountProductButton(cfg, attempt) {
    wlCfg = cfg;
    if (document.getElementById("badgehq-wl-product")) return;
    var m = window.location.pathname.match(/\/products\/([^/?#]+)/);
    if (!m) return;
    var handle = m[1];

    var anchor = resolveDeliveryAnchor(cfg.productPlacement === "above-atc" ? "above-atc" : "below-atc");
    if (!anchor || !anchor.target.parentNode) {
      if ((attempt || 0) < 12)
        setTimeout(function () { wlMountProductButton(cfg, (attempt || 0) + 1); }, 400);
      return;
    }

    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "badgehq-wl-product";
    btn.setAttribute("data-badgehq-wl-handle", handle);
    btn.style.cssText =
      "width:100%;display:flex;align-items:center;justify-content:center;gap:8px;margin:12px 0 0;" +
      "padding:12px 18px;font:inherit;font-weight:600;cursor:pointer;background:transparent;color:inherit;" +
      "border:1px solid rgba(0,0,0,0.6);border-radius:var(--buttons-radius,6px);box-sizing:border-box;";

    // Render as the theme ATC button's natural "secondary" variant: same
    // shape, height, and typography, outline instead of filled.
    var atcBtn = document.querySelector(
      "product-form button[type='submit'], form[action*='/cart/add'] button[type='submit'], " +
      ".product-form__submit, button[name='add'], [data-add-to-cart]"
    );
    if (atcBtn) {
      try {
        var abs = window.getComputedStyle(atcBtn);
        var abr = atcBtn.getBoundingClientRect();
        btn.style.borderRadius = abs.borderRadius;
        btn.style.fontSize = abs.fontSize;
        btn.style.fontWeight = abs.fontWeight;
        btn.style.fontFamily = abs.fontFamily;
        btn.style.letterSpacing = abs.letterSpacing;
        btn.style.textTransform = abs.textTransform;
        if (abr.height > 0) btn.style.minHeight = Math.round(abr.height) + "px";
        // Outline in the ATC's fill color so the pair reads as primary/secondary
        // — but only when that color is readable. On a sold-out variant the ATC
        // is disabled and light grey on most themes, which would render this
        // button as near-invisible grey-on-white.
        var atcBg = bisReadableColor(abs.backgroundColor);
        if (!atcBg) atcBg = bisReadableColor(window.getComputedStyle(document.body).color);
        if (!atcBg) atcBg = "#111111";
        btn.style.borderColor = atcBg;
        btn.style.color = atcBg;
      } catch (e) {}
    }

    btn.innerHTML =
      wlHeartSvg(wlHas(handle), cfg.iconColor, 18) +
      '<span data-wl-label>' + (wlHas(handle) ? "Added to wishlist" : "Add to wishlist") + "</span>";
    wlPaintHeart(btn, wlHas(handle));
    btn.addEventListener("click", function () { wlToggle(handle); });

    if (anchor.before) anchor.target.parentNode.insertBefore(btn, anchor.target);
    else anchor.target.parentNode.insertBefore(btn, anchor.target.nextSibling);
  }

  /* --- Surface: header icon with count --- */
  function wlMountHeaderIcon(cfg) {
    if (document.getElementById("badgehq-wl-header")) return;
    // Dawn family: .header__icons; DigiFist Release: ul.header__utils-items;
    // plus generic fallbacks. When the slot is a list, we add a proper <li>.
    var slot = document.querySelector(
      ".header__icons, .header__utils-items, header-icons, header .header__icons, " +
      "header [class*='header__icons'], header [class*='header-icons'], header [class*='utils-items']"
    );
    var a = document.createElement("a");
    a.id = "badgehq-wl-header";
    a.href = WL_PAGE;
    a.setAttribute("aria-label", "Wishlist");
    var count = wlGet().length;

    // The cart entry in the header — used both for positioning (we sit just
    // before it) and as the scope for finding the theme's cart count badge.
    var cartEl = slot
      ? slot.querySelector(
          "a[href*='/cart'], [data-cart-link], #cart-counter, a[onclick*='Cart'], [class*='utils-link--cart']"
        )
      : null;

    // Match the theme's own cart count badge so the wishlist count looks
    // native. Look INSIDE the cart link first; only then try the known theme
    // classes — and never match other apps' wishlist elements.
    var themeBadge = null;
    if (cartEl) {
      var inCart = cartEl.querySelectorAll("[class*='count'], [class*='bubble'] span, [class*='badge']");
      for (var tb1 = 0; tb1 < inCart.length; tb1++) {
        if (!/wishlist|badgehq/i.test(String(inCart[tb1].className))) { themeBadge = inCart[tb1]; break; }
      }
    }
    if (!themeBadge) {
      var cands = document.querySelectorAll(".cart-count-badge, .cart-count-bubble, [class*='cart-count']");
      for (var tb2 = 0; tb2 < cands.length; tb2++) {
        if (!/wishlist|badgehq/i.test(String(cands[tb2].className))) { themeBadge = cands[tb2]; break; }
      }
    }

    var badgeBg = cfg.iconColor;
    var badgeFg = "#fff";
    if (themeBadge) {
      try {
        var tb = window.getComputedStyle(themeBadge);
        if (tb.backgroundColor && tb.backgroundColor !== "rgba(0, 0, 0, 0)" && tb.backgroundColor !== "transparent") {
          badgeBg = tb.backgroundColor;
          badgeFg = tb.color || "#fff";
        }
      } catch (e) {}
    }
    var bubble =
      '<span data-badgehq-wl-count style="position:absolute;top:2px;right:0;min-width:17px;height:17px;' +
      "padding:0 4px;box-sizing:border-box;background:" + badgeBg + ";color:" + badgeFg + ";border-radius:9px;" +
      'font-size:10px;line-height:17px;text-align:center;font-weight:700;' +
      (count > 0 ? "" : "display:none;") + '">' + count + "</span>";

    if (slot) {
      a.style.cssText =
        "position:relative;display:inline-flex;align-items:center;justify-content:center;" +
        "width:44px;height:44px;color:inherit;";
      a.innerHTML = wlHeartSvg(false, "currentColor", 20) + bubble;
      var node = a;
      if (slot.tagName === "UL" || slot.tagName === "OL") {
        node = document.createElement("li");
        node.style.cssText = "display:inline-flex;align-items:center;list-style:none;";
        node.appendChild(a);
      }
      // Sit between the account/profile icon and the cart: insert directly
      // before the cart entry when we can find it, else append at the end.
      var cartItem = null;
      if (cartEl) {
        cartItem = cartEl;
        while (cartItem.parentNode && cartItem.parentNode !== slot) cartItem = cartItem.parentNode;
      }
      if (cartItem && cartItem.parentNode === slot) slot.insertBefore(node, cartItem);
      else slot.appendChild(node);

      // Clone the cart badge's exact geometry (size, font, radius, and its
      // offset relative to the cart link) so both badges look identical.
      if (themeBadge && cartEl) {
        try {
          var ourBubble = a.querySelector("[data-badgehq-wl-count]");
          // Themes hide the cart badge when the cart is empty — measure it
          // invisibly in that case, then restore. getComputedStyle is live,
          // so snapshot every value BEFORE restoring the hidden state.
          var restoreStyle = null;
          var restoreText = null;
          var badgeRect = themeBadge.getBoundingClientRect();
          if (badgeRect.width === 0) {
            restoreStyle = themeBadge.getAttribute("style") || "";
            themeBadge.style.setProperty("display", "block", "important");
            themeBadge.style.setProperty("visibility", "hidden", "important");
            if (!themeBadge.textContent) {
              restoreText = themeBadge.textContent;
              themeBadge.textContent = "1";
            }
            badgeRect = themeBadge.getBoundingClientRect();
          }
          var live = window.getComputedStyle(themeBadge);
          var snap = {
            lineHeight: live.lineHeight,
            fontSize: live.fontSize,
            fontWeight: live.fontWeight,
            fontFamily: live.fontFamily,
            borderRadius: live.borderRadius,
            padding: live.padding,
          };
          // Measure the badge offset against the cart's icon GLYPH (svg/img),
          // not the link box — link paddings differ between the cart and our
          // 44px anchor, and it's the glyph the badge visually attaches to.
          var cartIcon = cartEl.querySelector("svg, img, i, span:not([class*='count'])") || cartEl;
          var cartRect = cartIcon.getBoundingClientRect();
          if (cartRect.width === 0) cartRect = cartEl.getBoundingClientRect();
          var offTop = Math.round(badgeRect.top - cartRect.top);
          var offRight = Math.round(cartRect.right - badgeRect.right);
          if (restoreStyle !== null) themeBadge.setAttribute("style", restoreStyle);
          if (restoreText !== null) themeBadge.textContent = restoreText;

          // Sanity: a real cart badge hugs its icon. Degenerate measurements
          // (hidden/foreign elements at 0,0) would fling our bubble across
          // the header — keep the defaults in that case.
          if (Math.abs(offTop) > 30 || Math.abs(offRight) > 30) throw new Error("implausible-offset");

          // Translate that glyph-relative offset onto OUR heart glyph.
          var ourIcon = a.querySelector("svg");
          var ourIconRect = ourIcon ? ourIcon.getBoundingClientRect() : null;
          var ourARect = a.getBoundingClientRect();
          if (ourIconRect && ourIconRect.width > 0 && ourARect.width > 0) {
            offTop = Math.round(ourIconRect.top - ourARect.top) + offTop;
            offRight = Math.round(ourARect.right - ourIconRect.right) + offRight;
          }

          if (ourBubble && badgeRect.width > 0 && cartRect.width > 0) {
            ourBubble.style.minWidth = badgeRect.width + "px";
            ourBubble.style.height = badgeRect.height + "px";
            ourBubble.style.lineHeight = snap.lineHeight;
            ourBubble.style.fontSize = snap.fontSize;
            ourBubble.style.fontWeight = snap.fontWeight;
            ourBubble.style.fontFamily = snap.fontFamily;
            ourBubble.style.borderRadius = snap.borderRadius;
            ourBubble.style.padding = snap.padding;
            // Same corner offset the theme uses for the cart badge.
            ourBubble.style.top = offTop + "px";
            ourBubble.style.right = offRight + "px";
            ourBubble.setAttribute("data-wl-display", "flex");
            ourBubble.style.display = count > 0 ? "flex" : "none";
            ourBubble.style.alignItems = "center";
            ourBubble.style.justifyContent = "center";
          }
        } catch (e) {}
      }
    } else {
      // Fallback: floating button so the wishlist page is always reachable.
      a.style.cssText =
        "position:fixed;bottom:20px;right:20px;z-index:9990;display:flex;align-items:center;justify-content:center;" +
        "width:48px;height:48px;background:#fff;border-radius:50%;box-shadow:0 2px 10px rgba(0,0,0,0.2);color:#333;";
      a.innerHTML = wlHeartSvg(false, cfg.iconColor, 22) + bubble;
      document.body.appendChild(a);
    }
  }

  /* --- Wishlist page renderer --- */
  function wlRenderPage(cfg) {
    var container = document.querySelector("[data-badgehq-wishlist-page]");
    if (!container || container.getAttribute("data-wl-ready")) return;
    container.setAttribute("data-wl-ready", "1");

    var handles = wlGet();
    if (!handles.length) {
      container.innerHTML =
        '<p>Your wishlist is empty.</p><p><a href="/collections/all">Continue shopping</a></p>';
      return;
    }

    container.innerHTML =
      '<div data-wl-grid style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:20px;margin-top:16px;"></div>';
    var grid = container.querySelector("[data-wl-grid]");
    var missing = [];
    var pending = handles.length;

    function money(cents) {
      var cur = (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || "";
      return (cur === "INR" ? "₹" : cur ? cur + " " : "") + (cents / 100).toFixed(2).replace(/\.00$/, "");
    }

    function done() {
      if (--pending > 0) return;
      if (missing.length) {
        // Prune deleted products from the saved list.
        var list = wlGet().filter(function (h) { return missing.indexOf(h) === -1; });
        wlSave(list);
        wlScheduleSync();
      }
    }

    handles.forEach(function (handle) {
      fetch("/products/" + encodeURIComponent(handle) + ".js")
        .then(function (r) {
          if (!r.ok) throw new Error("gone");
          return r.json();
        })
        .then(function (p) {
          var card = document.createElement("div");
          card.style.cssText = "border:1px solid rgba(0,0,0,0.1);border-radius:8px;overflow:hidden;display:flex;flex-direction:column;";
          var img = p.featured_image || (p.images && p.images[0]) || "";
          var variant = null;
          for (var i = 0; i < (p.variants || []).length; i++) {
            if (p.variants[i].available) { variant = p.variants[i]; break; }
          }
          card.innerHTML =
            '<a href="/products/' + encodeURIComponent(handle) + '" style="display:block;">' +
            (img ? '<img src="' + img + '" alt="" loading="lazy" style="width:100%;aspect-ratio:1;object-fit:cover;display:block;">' : "") +
            "</a>" +
            '<div style="padding:12px;display:flex;flex-direction:column;gap:8px;flex:1;">' +
            '<a href="/products/' + encodeURIComponent(handle) + '" style="font-weight:600;color:inherit;text-decoration:none;">' +
            escapeDeHtml(p.title) + "</a>" +
            '<div style="opacity:0.85;">' + money(p.price) + "</div>" +
            '<div style="margin-top:auto;display:flex;gap:8px;">' +
            (variant
              ? '<button type="button" data-wl-atc="' + variant.id + '" style="flex:1;padding:9px 10px;font:inherit;font-weight:600;cursor:pointer;background:#111;color:#fff;border:none;border-radius:6px;">Add to cart</button>'
              : '<span style="flex:1;padding:9px 10px;text-align:center;opacity:0.6;">Sold out</span>') +
            '<button type="button" data-wl-remove="' + handle + '" aria-label="Remove" style="padding:9px 12px;font:inherit;cursor:pointer;background:transparent;border:1px solid rgba(0,0,0,0.25);border-radius:6px;">✕</button>' +
            "</div></div>";
          grid.appendChild(card);

          var atc = card.querySelector("[data-wl-atc]");
          if (atc)
            atc.addEventListener("click", function () {
              atc.disabled = true;
              atc.textContent = "Adding…";
              fetch("/cart/add.js", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: parseInt(atc.getAttribute("data-wl-atc"), 10), quantity: 1 }),
              })
                .then(function (r) { if (!r.ok) throw new Error("atc"); window.location.href = "/cart"; })
                .catch(function () { atc.disabled = false; atc.textContent = "Add to cart"; });
            });
          card.querySelector("[data-wl-remove]").addEventListener("click", function () {
            wlToggle(handle);
            card.remove();
            if (!grid.children.length) {
              container.removeAttribute("data-wl-ready");
              wlRenderPage(cfg);
            }
          });
          done();
        })
        .catch(function () {
          missing.push(handle);
          done();
        });
    });
  }

  function initWishlist(cfg, page) {
    wlCfg = cfg;
    wlInitialSync();
    if (cfg.showHeader) wlMountHeaderIcon(cfg);
    if (cfg.showOnCards) wlDecorateCards(cfg);
    if (cfg.showOnProduct && page === "product") wlMountProductButton(cfg, 0);
    wlRenderPage(cfg);
  }

  /* ===================== BACK IN STOCK ===================== */
  // Shows a "notify me" form when the selected variant is sold out. Sending is
  // Shopify-native (Flow trigger -> marketing automation -> Shopify Email), so
  // signing up also subscribes the shopper — the form says so before they
  // submit. Sold-out detection prefers the theme's own variant data and falls
  // back to the ATC button's `disabled` state, which every theme sets.
  var BIS_ENDPOINT = API_ORIGIN + "/api/back-in-stock";
  var BIS_KEY_PREFIX = "badgehq_bis_";
  var bisCfg = null;
  var bisHiddenBtn = null; // ATC button we hid for the replace-button placement

  function bisRoot() {
    // Scope to the main product; excludes quick-add drawers and featured
    // product sections that reuse <product-form>.
    return (
      document.querySelector("product-info[data-main-product]") ||
      document.querySelector("product-info") ||
      document.querySelector(".product__info-container, .product-form, main") ||
      document.body
    );
  }

  function bisAtcButton(root) {
    return root.querySelector(
      "product-form button[type='submit'], form[action*='/cart/add'] button[type='submit'], " +
      ".product-form__submit, button[name='add'], [data-add-to-cart]"
    );
  }

  function bisCurrentVariantId(root) {
    var input = root.querySelector("input[name='id']");
    if (input && /^\d+$/.test(input.value || "")) return input.value;
    var m = window.location.search.match(/[?&]variant=(\d+)/);
    if (m) return m[1];
    try {
      var meta = window.ShopifyAnalytics && window.ShopifyAnalytics.meta;
      if (meta && meta.selectedVariantId) return String(meta.selectedVariantId);
      if (meta && meta.product && meta.product.variants && meta.product.variants.length === 1)
        return String(meta.product.variants[0].id);
    } catch (e) {}
    return null;
  }

  function bisProductId() {
    try {
      var meta = window.ShopifyAnalytics && window.ShopifyAnalytics.meta;
      if (meta && meta.product && meta.product.id) return String(meta.product.id);
    } catch (e) {}
    return null;
  }

  // Is the current variant sold out? Prefer the theme's inlined variant JSON;
  // fall back to the ATC button being disabled.
  // Authoritative per-variant stock, fetched once per product and cached.
  // /products/<handle>.js is a public storefront endpoint every theme serves,
  // and unlike the theme's inlined variant JSON it carries inventory_quantity,
  // inventory_management and inventory_policy — the only way to distinguish
  // "out of stock" from "0 but still sellable (continue selling)".
  var bisVariantData = null;
  var bisVariantFetch = null;

  function bisProductHandle() {
    var m = window.location.pathname.match(/\/products\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  function bisLoadVariants(done) {
    if (bisVariantData) { done(bisVariantData); return; }
    if (bisVariantFetch) { bisVariantFetch.push(done); return; }
    var handle = bisProductHandle();
    if (!handle) { done(null); return; }
    bisVariantFetch = [done];
    fetch("/products/" + encodeURIComponent(handle) + ".js")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (p) {
        bisVariantData = (p && p.variants) || null;
        var queue = bisVariantFetch || [];
        bisVariantFetch = null;
        for (var i = 0; i < queue.length; i++) queue[i](bisVariantData);
      })
      .catch(function () {
        var queue = bisVariantFetch || [];
        bisVariantFetch = null;
        for (var i = 0; i < queue.length; i++) queue[i](null);
      });
  }

  // True only when the variant is genuinely unavailable to buy. A variant with
  // inventory_policy "continue" is still purchasable at 0 stock, so it must NOT
  // offer a notify form (the theme keeps Add to Cart enabled for it too).
  function bisVariantSoldOut(variants, variantId) {
    if (!variants || !variantId) return null;
    for (var i = 0; i < variants.length; i++) {
      var v = variants[i];
      if (String(v.id) !== String(variantId)) continue;
      if (v.available === false) return true;
      if (
        v.inventory_management === "shopify" &&
        typeof v.inventory_quantity === "number" &&
        v.inventory_quantity <= 0 &&
        v.inventory_policy !== "continue"
      ) {
        return true;
      }
      return false;
    }
    return null;
  }

  // Synchronous best-effort read, used before the product JSON arrives and as
  // the fallback when it can't be fetched. Note: never compare the button's
  // LABEL — themes retranslate "Sold out" (jmlooks renders "Restocking soon"),
  // so only the disabled attribute is trustworthy.
  function bisIsSoldOut(root) {
    var variantId = bisCurrentVariantId(root);
    var known = bisVariantSoldOut(bisVariantData, variantId);
    if (known !== null) return known;
    try {
      var sel = root.querySelector("[data-selected-variant]");
      if (sel && sel.innerHTML) {
        var v = JSON.parse(sel.innerHTML);
        if (v && typeof v.available === "boolean") return !v.available;
      }
      var all = root.querySelector(
        "[data-all-variants], variant-radios script[type='application/json'], " +
        "variant-selects script[type='application/json']"
      );
      if (all && all.textContent && variantId) {
        var list = JSON.parse(all.textContent);
        for (var i = 0; i < list.length; i++) {
          if (String(list[i].id) === String(variantId)) return !list[i].available;
        }
      }
    } catch (e) {}
    // Last resort. NOTE: on themes that re-render via the Section Rendering
    // API this attribute lags the shopper's click by a network round-trip, so
    // it can briefly describe the PREVIOUS variant. It's only used until the
    // product JSON above resolves, which then wins for good.
    var btn = bisAtcButton(root);
    return !!(btn && btn.hasAttribute("disabled"));
  }

  function bisAlreadySignedUp(variantId) {
    try {
      return localStorage.getItem(BIS_KEY_PREFIX + variantId) === "1";
    } catch (e) {
      return false;
    }
  }

  function bisRemember(variantId) {
    try {
      localStorage.setItem(BIS_KEY_PREFIX + variantId, "1");
    } catch (e) {}
  }

  function bisInjectStyle(cfg) {
    if (document.getElementById("badgehq-bis-style")) return;
    var style = document.createElement("style");
    style.id = "badgehq-bis-style";
    style.textContent =
      ".badgehq-bis{margin:12px 0;}" +
      ".badgehq-bis__btn{width:100%;display:flex;align-items:center;justify-content:center;gap:8px;" +
      "padding:12px 18px;font:inherit;font-weight:600;cursor:pointer;background:transparent;color:inherit;" +
      "border:1px solid rgba(0,0,0,0.6);border-radius:var(--buttons-radius,6px);box-sizing:border-box;}" +
      /* The panel spans the full button row. In the replace-button placement
         the wrapper is only as wide as the ATC slot, so --badgehq-bis-row-width
         (set at mount) lets the panel break out to the row's real width. */
      ".badgehq-bis__panel{display:none;margin-top:10px;padding:14px;border:1px solid rgba(0,0,0,0.12);" +
      "width:var(--badgehq-bis-row-width,100%);" +
      "margin-inline-start:var(--badgehq-bis-row-offset,0);box-sizing:border-box;" +
      "border-radius:var(--buttons-radius,6px);}" +
      ".badgehq-bis__panel.is-open{display:block;}" +
      ".badgehq-bis__heading{font-weight:600;margin:0 0 8px;}" +
      /* Wrap rather than squash if the widget lands in a narrow container. */
      ".badgehq-bis__row{display:flex;gap:8px;align-items:stretch;flex-wrap:wrap;}" +
      /* Fill the row. Themes often set a width/max-width on `input`, which
         would otherwise pin this to a narrow box, so the flex sizing is
         declared !important — this is the shopper-facing input and it must be
         usable on every theme. 12ch is only a floor for very narrow parents. */
      ".badgehq-bis__input{flex:1 1 auto !important;width:auto !important;max-width:none !important;" +
      "min-width:12ch;padding:10px 12px;font:inherit;box-sizing:border-box;" +
      "color:rgb(var(--color-foreground,18 18 18));background:rgb(var(--color-background,255 255 255));" +
      "border:1px solid rgba(var(--color-foreground,18 18 18),0.25);border-radius:var(--inputs-radius,4px);}" +
      ".badgehq-bis__input::placeholder{opacity:0.6;}" +
      ".badgehq-bis__submit{flex:none;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer;" +
      "color:rgb(var(--color-button-text,255 255 255));background:rgb(var(--color-button,18 18 18));" +
      "border:1px solid transparent;border-radius:var(--buttons-radius,4px);}" +
      ".badgehq-bis__submit:disabled{opacity:0.6;cursor:default;}" +
      ".badgehq-bis__note{margin:8px 0 0;font-size:0.85em;opacity:0.75;line-height:1.4;}" +
      ".badgehq-bis__msg{margin:8px 0 0;line-height:1.4;}" +
      ".badgehq-bis__msg--ok{color:#157a3d;}" +
      ".badgehq-bis__msg--err{color:#c62828;}";
    document.head.appendChild(style);
  }

  // Style our button like the theme's ATC button (secondary variant), the same
  // way the delivery/wishlist widgets do.
  // Return the colour only when it is opaque and dark enough to read as text
  // on a light background; otherwise null so the caller can fall back.
  // Perceived luminance (ITU-R BT.601) — grey #e0e0e0 scores ~224 and fails.
  function bisReadableColor(css) {
    if (!css) return null;
    var m = String(css).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    var p = m[1].split(",").map(function (n) { return parseFloat(n); });
    if (p.length < 3 || !isFinite(p[0])) return null;
    if (p.length > 3 && p[3] < 0.5) return null; // transparent
    var lum = 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
    return lum <= 160 ? "rgb(" + p[0] + "," + p[1] + "," + p[2] + ")" : null;
  }

  function bisStyleLikeAtc(btn, root) {
    var atc = bisAtcButton(root);
    if (!atc) return;
    try {
      var abs = window.getComputedStyle(atc);
      var abr = atc.getBoundingClientRect();
      btn.style.borderRadius = abs.borderRadius;
      btn.style.fontSize = abs.fontSize;
      btn.style.fontWeight = abs.fontWeight;
      btn.style.fontFamily = abs.fontFamily;
      btn.style.letterSpacing = abs.letterSpacing;
      btn.style.textTransform = abs.textTransform;
      if (abr.height > 0) btn.style.minHeight = Math.round(abr.height) + "px";
      // Borrow the ATC's colour — but ONLY if it's dark enough to read. On a
      // sold-out variant the ATC is in its disabled state (light grey on most
      // themes), and copying that gives near-invisible grey-on-white text.
      var bg = bisReadableColor(abs.backgroundColor);
      if (!bg) bg = bisReadableColor(window.getComputedStyle(root || document.body).color);
      if (!bg) bg = "#111111";
      btn.style.borderColor = bg;
      btn.style.color = bg;
    } catch (e) {}
  }

  // Make the widget span its parent's full width even when it was inserted
  // into a flex/grid slot that was sized for a single button.
  // For the replace-button placement: take over the hidden ATC button's own
  // slot so the notify button sits exactly where "Add to cart" was, at the
  // same width — rather than pushing itself onto a new line.
  function bisTakeAtcSlot(wrap, atc) {
    try {
      if (!atc) return;
      var as = window.getComputedStyle(atc);
      var parent = wrap.parentNode;
      // Copy the layout properties that decide the button's footprint.
      if (as.flex && as.flex !== "0 1 auto") wrap.style.flex = as.flex;
      if (as.gridColumn && as.gridColumn !== "auto") wrap.style.gridColumn = as.gridColumn;
      if (as.gridArea && as.gridArea !== "auto / auto / auto / auto") wrap.style.gridArea = as.gridArea;
      if (as.alignSelf && as.alignSelf !== "auto") wrap.style.alignSelf = as.alignSelf;
      if (as.marginBlockStart) wrap.style.marginBlockStart = as.marginBlockStart;
      if (as.marginBlockEnd) wrap.style.marginBlockEnd = as.marginBlockEnd;
      wrap.style.boxSizing = "border-box";
      wrap.style.minWidth = "0";
      // Width: match what the ATC actually occupied. offsetWidth is 0 because
      // we already hid it, so prefer its computed width and fall back to
      // filling the parent (the ATC is normally full-width anyway).
      var w = as.width;
      if (w && w !== "auto" && parseFloat(w) > 0) {
        wrap.style.width = w;
        wrap.style.maxWidth = "100%";
      } else {
        wrap.style.width = "100%";
      }

    } catch (e) {}
  }

  // The BUTTON matches the ATC's slot, but the expanded panel should span the
  // whole row so it lines up with the wishlist button beneath it. That needs
  // BOTH a width and a negative start offset: the wrapper usually sits partway
  // across the row, so setting width alone overflows the right edge (which is
  // exactly what pushed the "Notify me" button off screen).
  // Must run AFTER the ATC is hidden, or the wrapper hasn't taken its place yet.
  function bisMeasurePanelRow(wrap) {
    try {
      var parent = wrap.parentNode;
      if (!parent || parent.nodeType !== 1) return;
      var pr = parent.getBoundingClientRect();
      var pcs = window.getComputedStyle(parent);
      var padL = parseFloat(pcs.paddingLeft) || 0;
      var padR = parseFloat(pcs.paddingRight) || 0;
      var rowLeft = pr.left + padL;
      var rowWidth = pr.width - padL - padR;
      var wr = wrap.getBoundingClientRect();
      var offset = wr.left - rowLeft; // how far in the wrapper starts
      if (rowWidth <= 0) return;
      if (offset > 1 || rowWidth - wr.width > 1) {
        wrap.style.setProperty("--badgehq-bis-row-width", Math.round(rowWidth) + "px");
        wrap.style.setProperty("--badgehq-bis-row-offset", "-" + Math.round(offset) + "px");
      }
    } catch (e) {}
  }

  function bisRemove() {
    var el = document.getElementById("badgehq-back-in-stock");
    if (el) el.remove();
    // Restore the ATC button if the replace-button placement hid it.
    if (bisHiddenBtn) {
      bisHiddenBtn.style.display = "";
      bisHiddenBtn = null;
    }
  }

  function bisMount(cfg, attempt) {
    attempt = attempt || 0;
    if (document.getElementById("badgehq-back-in-stock")) return;

    var root = bisRoot();
    var variantId = bisCurrentVariantId(root);
    var productId = bisProductId();
    if (!variantId || !productId) {
      if (attempt < 12) setTimeout(function () { bisMount(cfg, attempt + 1); }, 400);
      return;
    }

    var atc = bisAtcButton(root);
    // Anchor outside the <form> so our email input is never submitted to
    // /cart/add. .product__buy-buttons is the Release theme's wrapper; the
    // form's parent is the generic fallback.
    var anchor =
      root.querySelector(".product__buy-buttons") ||
      (atc && atc.closest("form")) ||
      root.querySelector(".product-form__buttons, form[action*='/cart/add'], .product-form");
    if (!anchor || !anchor.parentNode) {
      if (attempt < 12) setTimeout(function () { bisMount(cfg, attempt + 1); }, 400);
      return;
    }

    bisInjectStyle(cfg);

    var wrap = document.createElement("div");
    wrap.id = "badgehq-back-in-stock";
    wrap.className = "badgehq-bis";
    wrap.setAttribute("data-bis-variant", variantId);

    if (bisAlreadySignedUp(variantId)) {
      wrap.innerHTML = '<p class="badgehq-bis__msg badgehq-bis__msg--ok">' +
        escapeDeHtml(cfg.successText) + "</p>";
    } else {
      wrap.innerHTML =
        '<button type="button" class="badgehq-bis__btn" data-bis-open>' +
        escapeDeHtml(cfg.buttonText) + "</button>" +
        '<div class="badgehq-bis__panel" data-bis-panel>' +
        '<p class="badgehq-bis__heading">' + escapeDeHtml(cfg.headingText) + "</p>" +
        '<div class="badgehq-bis__row">' +
        '<input class="badgehq-bis__input" type="tel" inputmode="numeric" autocomplete="tel" ' +
        // "WhatsApp number" alone left shoppers unsure whether to include +91,
        // spaces or a leading zero — state the expected format instead.
        'maxlength="10" placeholder="10-digit mobile number" ' +
        'aria-label="Your WhatsApp number, 10 digits without the country code" data-bis-phone>' +
        '<button type="button" class="badgehq-bis__submit" data-bis-submit>Notify me</button>' +
        "</div>" +
        '<p class="badgehq-bis__note">' + escapeDeHtml(cfg.consentText) + "</p>" +
        '<div class="badgehq-bis__msg" data-bis-msg aria-live="polite"></div>' +
        "</div>";
    }

    // Placement.
    if (cfg.placement === "replace-button" && atc) {
      if (atc.parentNode) {
        atc.parentNode.insertBefore(wrap, atc.nextSibling);
        // Measure the ATC BEFORE hiding it — a display:none element reports no
        // usable geometry — so the notify button lands in the same slot at the
        // same width instead of wrapping onto its own line.
        bisTakeAtcSlot(wrap, atc);
        atc.style.display = "none";
        bisHiddenBtn = atc;
        // The wrapper only settles into the ATC's place once the ATC is gone,
        // so the panel's break-out offset has to be measured now, not above.
        bisMeasurePanelRow(wrap);
      } else {
        atc.style.display = "none";
        bisHiddenBtn = atc;
        anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
      }
    } else if (cfg.placement === "above-atc") {
      anchor.parentNode.insertBefore(wrap, anchor);
    } else {
      anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
    }

    var openBtn = wrap.querySelector("[data-bis-open]");
    if (openBtn) {
      bisStyleLikeAtc(openBtn, root);
      var panel = wrap.querySelector("[data-bis-panel]");
      openBtn.addEventListener("click", function () {
        panel.classList.toggle("is-open");
        var input = wrap.querySelector("[data-bis-phone]");
        if (panel.classList.contains("is-open") && input) input.focus();
      });
    }

    var submit = wrap.querySelector("[data-bis-submit]");
    if (submit) {
      submit.addEventListener("click", function () {
        bisSubmit(wrap, cfg, variantId, productId);
      });
      var phoneField = wrap.querySelector("[data-bis-phone]");
      if (phoneField) {
        phoneField.addEventListener("keydown", function (e) {
          if (e.key === "Enter") {
            e.preventDefault();
            bisSubmit(wrap, cfg, variantId, productId);
          }
        });
        phoneField.addEventListener("input", function () {
          phoneField.value = phoneField.value.replace(/\D/g, "").slice(0, 10);
        });
      }
    }
  }

  function bisSubmit(wrap, cfg, variantId, productId) {
    var phoneInput = wrap.querySelector("[data-bis-phone]");
    var submit = wrap.querySelector("[data-bis-submit]");
    var msg = wrap.querySelector("[data-bis-msg]");
    // Accept "+91 98765 43210" / "098765 43210" / "9876543210".
    var phone = (phoneInput ? phoneInput.value || "" : "").replace(/\D/g, "");
    if (phone.length > 10 && phone.indexOf("91") === 0) phone = phone.slice(2);
    if (phone.length === 11 && phone.charAt(0) === "0") phone = phone.slice(1);

    function setMsg(kind, text) {
      msg.className = "badgehq-bis__msg" + (kind ? " badgehq-bis__msg--" + kind : "");
      msg.textContent = text;
    }

    // The number IS the subscription — there is no other way to notify them.
    if (!/^[6-9]\d{9}$/.test(phone)) {
      setMsg("err", "Enter your 10-digit mobile number, without +91 or spaces.");
      if (phoneInput) phoneInput.focus();
      return;
    }

    submit.disabled = true;
    setMsg("", "Signing you up…");

    fetch(BIS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shop: SHOP,
        variantId: variantId,
        productId: productId,
        phone: phone,
      }),
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (data) {
        if (data && data.ok) {
          bisRemember(variantId);
          wrap.innerHTML = '<p class="badgehq-bis__msg badgehq-bis__msg--ok">' +
            escapeDeHtml(cfg.successText) + "</p>";
        } else {
          submit.disabled = false;
          setMsg("err", "Couldn’t sign you up right now. Please try again.");
        }
      })
      .catch(function () {
        submit.disabled = false;
        setMsg("err", "Couldn’t sign you up right now. Please try again.");
      });
  }

  // Show the form only while the selected variant is sold out.
  function bisSync(cfg) {
    var root = bisRoot();
    var soldOut = bisIsSoldOut(root);
    var existing = document.getElementById("badgehq-back-in-stock");
    var variantId = bisCurrentVariantId(root);

    if (!soldOut) {
      if (existing) bisRemove();
      return;
    }
    // Sold out: (re)mount if missing, or if the shopper switched to a
    // different sold-out variant.
    if (existing && existing.getAttribute("data-bis-variant") !== String(variantId)) {
      bisRemove();
      existing = null;
    }
    if (!existing) bisMount(cfg, 0);
  }

  function initBackInStock(cfg) {
    bisCfg = cfg;
    bisSync(cfg);

    // Fetch authoritative inventory once, then re-evaluate: this is what tells
    // a genuinely sold-out variant apart from a continue-selling one.
    bisLoadVariants(function () { bisSync(cfg); });

    // Themes re-render the buy buttons on variant change. Prefer the theme's
    // own pub/sub (Dawn/Release expose it globally); the MutationObserver on
    // the ATC button's disabled state is the universal fallback and also
    // covers nil-variant and quantity-rule cases where no event fires.
    try {
      if (typeof window.subscribe === "function" && window.PUB_SUB_EVENTS) {
        window.subscribe(window.PUB_SUB_EVENTS.variantChange, function () {
          setTimeout(function () { bisSync(cfg); }, 50);
        });
      }
    } catch (e) {}

    // Radio/select changes fire IMMEDIATELY, before the theme's section fetch
    // resolves. Since our stock map is local, we can settle on the right state
    // without waiting for (or trusting) the theme's re-render.
    document.addEventListener("change", function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (
        t.closest("variant-radios, variant-selects, product-variant-selects, .product-form__input") ||
        (t.name === "id" && t.closest("form[action*='/cart/add']"))
      ) {
        setTimeout(function () { bisSync(cfg); }, 0);
      }
    });

    var debounce = null;
    if (window.MutationObserver) {
      var observer = new MutationObserver(function () {
        clearTimeout(debounce);
        debounce = setTimeout(function () { bisSync(cfg); }, 300);
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["disabled"],
      });
    }

    // Combined-listing product swaps replace the whole subtree.
    document.addEventListener("product-info:loaded", function () {
      bisHiddenBtn = null;
      setTimeout(function () { bisSync(cfg); }, 100);
    });
    document.addEventListener("shopify:section:load", function () {
      bisHiddenBtn = null;
      setTimeout(function () { bisSync(cfg); }, 100);
    });
  }

  /* ===================== AI REPLIES (chat) ===================== */
  // Floating chat bubble that answers from the merchant's knowledge text via
  // /api/ai-reply. The merchant's Gemini key never reaches the browser, and the
  // transcript lives only in sessionStorage — nothing is stored server-side.
  var AI_ENDPOINT = API_ORIGIN + "/api/ai-reply";
  var AI_KEY = "badgehq_ai_chat";
  var AI_MAX_TURNS = 10;
  var AI_MAX_CHARS = 1000;

  function aiLoadHistory() {
    try {
      var raw = JSON.parse(sessionStorage.getItem(AI_KEY) || "[]");
      return Object.prototype.toString.call(raw) === "[object Array]" ? raw.slice(-AI_MAX_TURNS) : [];
    } catch (e) {
      return [];
    }
  }

  function aiSaveHistory(history) {
    try {
      sessionStorage.setItem(AI_KEY, JSON.stringify(history.slice(-AI_MAX_TURNS)));
    } catch (e) {}
  }

  function initAiReplies(cfg) {
    if (document.getElementById("badgehq-ai-chat")) return;

    var accent = cfg.accentColor || "#111111";
    var side = cfg.position === "bottom-left" ? "left:20px;" : "right:20px;";
    var history = aiLoadHistory();

    if (!document.getElementById("badgehq-ai-style")) {
      var style = document.createElement("style");
      style.id = "badgehq-ai-style";
      style.textContent =
        // bottom = base 20px + an offset a host page can raise (e.g. a sticky
        // add-to-cart bar) via --badgehq-ai-offset, animated so it glides up.
        ".badgehq-ai-bubble{position:fixed;bottom:calc(20px + var(--badgehq-ai-offset, 0px));" + side +
        "z-index:9992;width:56px;height:56px;display:flex;align-items:center;justify-content:center;" +
        "border:none;border-radius:50%;cursor:pointer;background:" + accent + ";color:#fff;" +
        "box-shadow:0 4px 14px rgba(0,0,0,0.25);transition:bottom 350ms cubic-bezier(0.22,1,0.36,1);}" +
        ".badgehq-ai-panel{position:fixed;bottom:calc(88px + var(--badgehq-ai-offset, 0px));" + side +
        "z-index:9992;width:340px;max-width:calc(100vw - 32px);height:460px;max-height:calc(100vh - 120px);" +
        "display:none;flex-direction:column;overflow:hidden;background:#fff;color:#1a1a1a;" +
        "border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,0.22);font-size:14px;line-height:1.5;}" +
        ".badgehq-ai-panel.is-open{display:flex;}" +
        ".badgehq-ai-head{display:flex;align-items:center;justify-content:space-between;gap:8px;" +
        "padding:12px 14px;background:" + accent + ";color:#fff;font-weight:600;}" +
        ".badgehq-ai-close{background:none;border:none;color:#fff;font-size:20px;line-height:1;cursor:pointer;padding:0 4px;}" +
        ".badgehq-ai-log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;}" +
        ".badgehq-ai-msg{max-width:85%;padding:9px 12px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word;}" +
        ".badgehq-ai-msg--bot{align-self:flex-start;background:#f1f1f3;border-bottom-left-radius:4px;}" +
        ".badgehq-ai-msg--bot a{color:" + accent + ";text-decoration:underline;font-weight:600;overflow-wrap:anywhere;}" +
        ".badgehq-ai-msg--user{align-self:flex-end;background:" + accent + ";color:#fff;border-bottom-right-radius:4px;}" +
        ".badgehq-ai-foot{display:flex;gap:8px;padding:10px;border-top:1px solid rgba(0,0,0,0.08);}" +
        ".badgehq-ai-input{flex:1 1 auto;min-width:0;padding:9px 11px;font:inherit;box-sizing:border-box;" +
        "border:1px solid rgba(0,0,0,0.2);border-radius:8px;}" +
        ".badgehq-ai-send{flex:none;padding:9px 14px;font:inherit;font-weight:600;cursor:pointer;" +
        "background:" + accent + ";color:#fff;border:none;border-radius:8px;}" +
        ".badgehq-ai-send:disabled{opacity:0.55;cursor:default;}" +
        ".badgehq-ai-help{padding:0 14px 10px;font-size:12px;}" +
        ".badgehq-ai-help a{color:" + accent + ";}" +
        "@media (max-width:480px){.badgehq-ai-panel{left:12px;right:12px;width:auto;bottom:84px;height:70vh;}}";
      document.head.appendChild(style);
    }

    var wrap = document.createElement("div");
    wrap.id = "badgehq-ai-chat";
    wrap.innerHTML =
      '<div class="badgehq-ai-panel" data-ai-panel role="dialog" aria-label="' +
      escapeDeHtml(cfg.botName || "Support") + '">' +
      '<div class="badgehq-ai-head"><span>' + escapeDeHtml(cfg.botName || "Support") + "</span>" +
      '<button type="button" class="badgehq-ai-close" data-ai-close aria-label="Close chat">&times;</button></div>' +
      '<div class="badgehq-ai-log" data-ai-log aria-live="polite"></div>' +
      aiContactHtml(cfg) +
      '<div class="badgehq-ai-foot">' +
      '<input class="badgehq-ai-input" data-ai-input type="text" maxlength="' + AI_MAX_CHARS +
      '" placeholder="Ask a question…" aria-label="Your message">' +
      '<button type="button" class="badgehq-ai-send" data-ai-send>Send</button>' +
      "</div></div>" +
      '<button type="button" class="badgehq-ai-bubble" data-ai-toggle aria-label="Chat with us">' +
      '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true">' +
      '<path d="M12 3C6.9 3 3 6.6 3 11c0 2.2 1 4.2 2.7 5.6L5 21l4.6-2.3c.8.2 1.6.3 2.4.3 5.1 0 9-3.6 9-8s-3.9-8-9-8Z"/>' +
      "</svg></button>";
    document.body.appendChild(wrap);

    var panel = wrap.querySelector("[data-ai-panel]");
    var log = wrap.querySelector("[data-ai-log]");
    var input = wrap.querySelector("[data-ai-input]");
    var sendBtn = wrap.querySelector("[data-ai-send]");

    // Render a bot reply, turning markdown [label](url) into real links.
    // Built as DOM nodes (never innerHTML) because the text comes from an LLM:
    // anything that isn't a recognised link stays literal text, so injected
    // markup can't execute. Only safe schemes are linkified.
    var AI_LINK_RE = /\[([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+|tel:[^\s)]+)\)/g;

    function aiFillText(el, text) {
      var last = 0;
      var m;
      AI_LINK_RE.lastIndex = 0;
      while ((m = AI_LINK_RE.exec(text)) !== null) {
        if (m.index > last) {
          el.appendChild(document.createTextNode(text.slice(last, m.index)));
        }
        var a = document.createElement("a");
        a.href = m[2];
        a.textContent = m[1];
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        el.appendChild(a);
        last = m.index + m[0].length;
      }
      if (last < text.length) {
        el.appendChild(document.createTextNode(text.slice(last)));
      }
    }

    function addMsg(role, text) {
      var el = document.createElement("div");
      el.className = "badgehq-ai-msg badgehq-ai-msg--" + (role === "user" ? "user" : "bot");
      if (role === "user") {
        el.textContent = text; // never linkify shopper input
      } else {
        aiFillText(el, text);
      }
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
      return el;
    }

    // Replay this session's conversation, or greet.
    if (history.length) {
      for (var i = 0; i < history.length; i++) {
        addMsg(history[i].role === "user" ? "user" : "bot", history[i].text);
      }
    } else if (cfg.greeting) {
      addMsg("bot", cfg.greeting);
    }

    wrap.querySelector("[data-ai-toggle]").addEventListener("click", function () {
      panel.classList.toggle("is-open");
      if (panel.classList.contains("is-open")) {
        input.focus();
        log.scrollTop = log.scrollHeight;
      }
    });
    wrap.querySelector("[data-ai-close]").addEventListener("click", function () {
      panel.classList.remove("is-open");
    });

    function send() {
      var text = (input.value || "").trim().slice(0, AI_MAX_CHARS);
      if (!text) return;
      input.value = "";
      addMsg("user", text);
      history.push({ role: "user", text: text });
      aiSaveHistory(history);

      sendBtn.disabled = true;
      var pending = addMsg("bot", "…");

      fetch(AI_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shop: SHOP,
          message: text,
          // Exclude the turn we just added; the server appends it.
          history: history.slice(0, -1).slice(-AI_MAX_TURNS),
        }),
      })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (data) {
          var reply = (data && data.text) || "Sorry — I couldn't answer that.";
          pending.textContent = "";
          aiFillText(pending, reply);
          if (data && data.ok) {
            history.push({ role: "model", text: reply });
            aiSaveHistory(history);
          }
        })
        .catch(function () {
          pending.textContent = "Sorry — I couldn't reach support just now. Please try again.";
        })
        .finally(function () {
          sendBtn.disabled = false;
          log.scrollTop = log.scrollHeight;
          input.focus();
        });
    }

    sendBtn.addEventListener("click", send);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        send();
      }
    });
  }

  function aiContactHtml(cfg) {
    var bits = [];
    if (cfg.supportEmail) {
      bits.push('<a href="mailto:' + escapeDeHtml(cfg.supportEmail) + '">' + escapeDeHtml(cfg.supportEmail) + "</a>");
    }
    if (cfg.supportUrl) {
      bits.push('<a href="' + escapeDeHtml(cfg.supportUrl) + '" target="_blank" rel="noopener">Message us</a>');
    }
    if (!bits.length) return "";
    return '<div class="badgehq-ai-help">Need a person? ' + bits.join(" &middot; ") + "</div>";
  }

  /** The current product page's handle, from the canonical link - present on
   *  every product page and unaffected by query strings or variant choice. */
  function productHandleFromPage() {
    var c = document.querySelector('link[rel="canonical"]');
    var href = c && c.href ? c.href : window.location.href;
    var m = href.match(/\/products\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  }

  /* ===================== BEHAVIOUR BEACON ===================== */
  /**
   * Feeds collection ranking: which products shoppers view, dwell on, add to
   * cart and wishlist.
   *
   * Batched for the whole session and sent ONCE, when the page is hidden. A
   * request per event would be millions a day at this traffic; this is one
   * beacon per visit. sendBeacon hands the payload to the browser, which
   * delivers it after the page is gone - so nothing here can delay a
   * navigation or block rendering.
   *
   * Counts are per session and capped server-side. Nothing identifies the
   * shopper: the payload is product ids and small integers.
   */
  function initBehaviourBeacon(page) {
    if (!SHOP || !navigator.sendBeacon) return;

    var KEY = "badgehq-behaviour";
    var bag = {};
    try {
      bag = JSON.parse(sessionStorage.getItem(KEY) || "{}") || {};
    } catch (e) {
      bag = {};
    }

    function bump(id, field, by, handle) {
      if (!id) return;
      // A numeric id stays numeric; a handle is kept as-is. Stripping
      // non-digits unconditionally turned every handle into an empty string
      // and silently dropped the event.
      var raw = String(id);
      var k = /^\d+$/.test(raw) ? raw : raw.replace(/[^a-z0-9-]/gi, "").toLowerCase();
      if (!k) return;
      // Re-read before writing. bag was read once when this page loaded,
      // and a shopper who opens a product, is recorded there, and comes
      // back gets this page restored from the bfcache rather than
      // reloaded - so this copy is older than storage. Writing it back
      // wholesale erased the view and dwell recorded on the product page.
      try {
        var fresh = JSON.parse(sessionStorage.getItem(KEY) || "null");
        if (fresh) {
          for (var fk in fresh) {
            if (!bag[fk]) bag[fk] = fresh[fk];
            else {
              // Keep whichever count is higher: this page may hold a bump
              // not yet flushed, storage may hold one from another page.
              var cur = bag[fk];
              var got = fresh[fk];
              for (var f2 in got) {
                if (typeof got[f2] === "number") {
                  if (typeof cur[f2] !== "number" || got[f2] > cur[f2]) cur[f2] = got[f2];
                } else if (!cur[f2]) {
                  cur[f2] = got[f2];
                }
              }
            }
          }
        }
      } catch (e0) {
        /* unreadable storage - the in-memory bag is all there is */
      }
      if (!bag[k]) bag[k] = { p: k };
      bag[k][field] = (bag[k][field] || 0) + (by || 1);
      // Handle and timestamp are for the client-side reorder only and are
      // never sent: the beacon strips everything except p and the counters.
      // A grid identifies a card by the handle in its link, so an id alone
      // cannot be acted on there.
      // Prefer a handle the caller knows (a cart line, a clicked card);
      // fall back to the page. Without this, anything detected away from a
      // product page has no handle and the grid cannot act on it.
      var h = handle || productHandleFromPage();
      if (h) bag[k].h = h;
      bag[k].t = Date.now();
      try {
        sessionStorage.setItem(KEY, JSON.stringify(bag));
      } catch (e) {
        /* private mode / quota - the beacon still sends what is in memory */
      }
      // Every engagement funnels through here - view, dwell, cart, wishlist
      // - so this is the one place that knows the shopper just changed what
      // is relevant to them. The reorder warms its cards from it.
      if (__bhqOnEngage) __bhqOnEngage();
    }

    /**
     * The product being viewed, as an id when one is available.
     *
     * meta[property="product:id"] is a theme convention, not a Shopify
     * guarantee, and this store's theme does not emit it - measured, not
     * assumed. ShopifyAnalytics.meta is populated asynchronously, so it is
     * usually still empty when the widget initialises. Hence the retry: the
     * id is worth having for the server counters, but nothing waits on it.
     */
    function currentProductId() {
      var m = document.querySelector('meta[property="product:id"]');
      if (m && m.content) return m.content;
      if (window.ShopifyAnalytics && window.ShopifyAnalytics.meta &&
          window.ShopifyAnalytics.meta.product) {
        return window.ShopifyAnalytics.meta.product.id;
      }
      var mp = window.meta && window.meta.product;
      if (mp && mp.id) return mp.id;
      return null;
    }

    // Keyed by HANDLE when no id can be found. The canonical link is on every
    // product page, so this always resolves - and the handle is what the grid
    // reorder matches on anyway. Without this a theme that omits the meta tag
    // records nothing at all, which is what was happening here.
    var pid = null;
    if (page === "product") {
      pid = currentProductId() || productHandleFromPage();
      if (pid) bump(pid, "v", 1);
      // ShopifyAnalytics may arrive late; if it brings a real id, record the
      // view against that too so the server sees a product id rather than a
      // handle. Deduped by the id being a different key.
      if (!/^\d+$/.test(String(pid))) {
        setTimeout(function () {
          var real = currentProductId();
          if (real && !bag[String(real)]) bump(real, "v", 1);
        }, 2000);
      }
    }

    // Dwell: counted once, at 30s, rather than timing the whole visit - the
    // signal is "did they actually look at this", not how long exactly.
    if (pid) {
      var dwellSent = false;
      setTimeout(function () {
        if (!dwellSent && !document.hidden) {
          dwellSent = true;
          bump(pid, "d", 1);
        }
      }, 30000);
    }

    // Cart adds, observed by diffing /cart.js rather than guessing from
    // clicks: themes and headless checkouts rewire the add button, and a
    // click that failed is not an add.
    // Maps product id -> handle for everything in the cart, so a cart add
    // detected on a collection page still knows which product it was.
    function readCart(then) {
      fetch("/cart.js", { credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (c) {
          var seen = {};
          // Quantity, not just presence: adding a second unit of something
          // already in the cart is still an add, and a presence-only diff
          // cannot see it.
          (c && c.items ? c.items : []).forEach(function (i) {
            var k = String(i.product_id);
            if (!seen[k]) seen[k] = { q: 0, h: i.handle || null };
            seen[k].q += Number(i.quantity) || 0;
          });
          then(seen);
        })
        .catch(function () {});
    }

    var CART_KEY = "badgehq-behaviour-cart";
    var prevCart = {};
    try {
      prevCart = JSON.parse(sessionStorage.getItem(CART_KEY) || "{}") || {};
      // An earlier build stored a handle string per id rather than a
      // {q, h} record. Reading one as the new shape gives q undefined and
      // would report the whole cart as newly added, so drop it and let the
      // next read rebuild the baseline.
      for (var ck in prevCart) {
        if (!prevCart[ck] || typeof prevCart[ck] !== "object") { prevCart = {}; break; }
      }
    } catch (e) {
      prevCart = {};
    }
    function diffCart(isFirstRead) {
      readCart(function (now) {
        // The first read establishes a baseline only. Whatever is already in
        // the cart was added on some earlier page - counting it here would
        // credit it again on every page load.
        if (!isFirstRead) {
          for (var id in now) {
            var was = prevCart[id] ? prevCart[id].q || 0 : 0;
            var gained = (now[id].q || 0) - was;
            if (gained > 0) bump(id, "ca", gained, now[id].h);
          }
          for (var old in prevCart) {
            var before = prevCart[old].q || 0;
            var after = now[old] ? now[old].q || 0 : 0;
            if (after < before) bump(old, "cr", before - after, prevCart[old].h);
          }
        }
        prevCart = now;
        try {
          sessionStorage.setItem(CART_KEY, JSON.stringify(now));
        } catch (e) {}
      });
    }
    // Baseline on load; every later read is a real comparison.
    diffCart(!Object.keys(prevCart).length);

    // Adding to cart does not reload the page on most themes, so a load-time
    // diff alone never sees it. The hooks at the top of this file flag a cart
    // write the moment it happens; this reacts to that flag.
    __bhqOnCartWrite = function () { setTimeout(diffCart, 900); };
    // A write that landed before the beacon started - the shopper added to
    // cart while the config was still loading - is still pending here.
    if (__bhqCartDirty) setTimeout(diffCart, 300);

    // Wishlist, including WishlistHero's own buttons - this store uses that
    // app rather than the built-in wishlist, so matching only our own class
    // would record nothing.
    document.addEventListener(
      "click",
      function (e) {
        var btn = e.target.closest
          // wishlisthero-floating is the class on the heart WishlistHero
          // injects onto a product card - the one a shopper actually clicks on
          // a collection page. It is added by their script, so it is absent
          // from the server HTML and was missed when these selectors were
          // written from it. [class*="wishlist"] catches the rest.
          ? e.target.closest(
              "[data-wlh-id], [data-wlh-handle], .wishlisthero-floating, " +
                ".wishlist-hero-custom-button, .wishlist-btn, [data-wishlist-hero], " +
                "[class*='wishlist'], [class*='Wishlist']",
            )
          : null;
        if (!btn) return;
        var card = btn.closest("[data-product-id]");
        // Measured on this store: WishlistHero renders data-wlh-handle and
        // NOT data-wlh-id, and the cards carry no data-product-id either, so
        // every id source failed and the click was dropped. The handle is a
        // first-class key now, so it can be used directly.
        var wrap = btn.closest ? btn.closest("li, article, .card-wrapper, [class*='product-card']") : null;
        var wlHandle =
          (btn.dataset ? btn.dataset.wlhHandle : null) ||
          (wrap ? wlHandleFromLink(wrap) : null) ||
          productHandleFromPage();
        var id =
          (card && card.dataset ? card.dataset.productId : null) ||
          (btn.dataset ? btn.dataset.wlhId || btn.dataset.productId : null) ||
          pid ||
          wlHandle;
        if (!id) return;
        // The class flips after the app handles the click, so read it late.
        // Read the state from the whole button subtree, not just the element
        // that matched. WishlistHero marks the INNER button with
        // wishlisthero-product-in-wishlist and never touches the wrapper the
        // click resolves to, so comparing the wrapper class saw no change on
        // every click - and the old "no change means add" fallback then
        // recorded each removal as a second add. Measured: a wishlist then
        // un-wishlist stored wa:2 instead of wa:1, wr:1, which ranked a
        // removed product ABOVE one that was still wishlisted.
        var wlOnRe = /wishlisthero-product-in-wishlist|wishlisted|is-active|added|selected|filled/i;
        var wlState = function (el) {
          if (!el) return false;
          if (wlOnRe.test(el.className || "")) return true;
          return !!(el.querySelector && el.querySelector('[class*="in-wishlist"], [class*="wishlisted"], [aria-pressed="true"]'));
        };
        var before = wlState(btn);
        setTimeout(function () {
          var after = wlState(btn);
          // Unchanged means the state is somewhere this cannot see. Recording
          // nothing is right: a wrong guess does not just miss a signal, it
          // inverts one, and an invented add outranks a real one.
          if (after === before) return;
          bump(id, after ? "wa" : "wr", 1, wlHandle);
        }, 400);
      },
      true,
    );

    /**
     * Send what has not been sent yet, on every page hide.
     *
     * This used to send once and then latch, which looked right for a single
     * page view but is wrong for a session: the bag lives in sessionStorage and
     * survives navigation, so after the first flush every later view, cart add
     * and wishlist click was counted locally and never transmitted.
     *
     * Each counter now carries how much of it has already gone up, and only the
     * difference is sent. A beacon that never arrives is retried on the next
     * page hide rather than lost, and nothing is ever counted twice.
     */
    function flush() {
      var events = [];
      var marks = [];
      for (var k in bag) {
        var b = bag[k];
        var sentMap = b.s || {};
        var e = { p: b.p };
        var any = false;
        var fields = ["v", "d", "ca", "cr", "wa", "wr"];
        for (var fi = 0; fi < fields.length; fi++) {
          var f = fields[fi];
          var delta = (b[f] || 0) - (sentMap[f] || 0);
          if (delta > 0) {
            e[f] = delta;
            any = true;
          }
        }
        if (any) {
          events.push(e);
          marks.push(b);
        }
      }
      if (!events.length) return;
      try {
        var ok = navigator.sendBeacon(
          API_ORIGIN + "/api/behaviour",
          new Blob([JSON.stringify({ shop: SHOP, events: events })], {
            type: "application/json",
          }),
        );
        // Only mark as sent once the browser has taken the payload. If it
        // refused, the same deltas go again next time.
        if (ok) {
          for (var mi = 0; mi < marks.length; mi++) {
            var m = marks[mi];
            m.s = {
              v: m.v || 0, d: m.d || 0, ca: m.ca || 0,
              cr: m.cr || 0, wa: m.wa || 0, wr: m.wr || 0,
            };
          }
          sessionStorage.setItem(KEY, JSON.stringify(bag));
        }
      } catch (e2) {
        /* never let tracking break a page */
      }
    }
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) flush();
    });
  }

  /* ============== PERSONALISED GRID ORDER (client-side) ==============
   *
   * Lifts the products THIS shopper has shown interest in to the top of a
   * collection grid, instantly and without a server round trip.
   *
   * Works on any theme the app is installed on: cards are found by the same
   * selector list the wishlist hearts already use, and a product is identified
   * by the handle in its own link, so nothing depends on a merchant adding
   * markup or editing a template.
   *
   * This is deliberately separate from the hourly server ranking. The server
   * decides the base order for everyone from sales, reviews and newness; this
   * only promotes a handful of cards for one shopper. Scores come from the
   * same counters the beacon sends, read back out of sessionStorage, so the
   * two never disagree about what a shopper did.
   */
  /** A finite, non-negative number, or the fallback. */
  function num(v, dflt) {
    var n = Number(v);
    return isFinite(n) && n >= 0 ? n : dflt;
  }

  /**
   * The shop's full ranked order, as handles, position = rank.
   *
   * Fetched once and cached for the session. A card is ~45KB of markup so a
   * theme can only paginate two dozen, but the ORDER is ~30 bytes a product -
   * around 11KB gzipped for a thousand - so the whole ranking fits in one
   * small request even though the cards never could.
   *
   * Without it the base ranking is DOM position, which only describes the
   * cards currently on screen: a product the shopper wants cannot be placed
   * against products that have not loaded.
   */
  var _orderRank = null;
  /** handle -> the handles most like it, best first. */
  var _neighbours = {};
  /** How strongly each product resembles what this shopper engaged with.
   *
   *  Kept apart from the score boost on purpose. The boost competes with the
   *  global ranking and loses - a bestselling tee outscores a wanted heel by
   *  more than any boost can close. This is used instead to reserve the lead
   *  slots of each new page, so similarity decides the ORDER products are
   *  served in without altering what they are worth. */
  var _affinityRank = null;
  /** Injection runs once per page load. The re-sort that follows one calls
   *  back into the sort, and anything short of a latch lets that recurse. */
  var _injectedOnce = false;
  function loadOrderRank(then) {
    if (_orderRank) return then(_orderRank);
    // Fetched on every page load. Nothing is read back from storage.
    //
    // This was cached in sessionStorage for the whole session, which made it
    // fast and made it wrong: sessionStorage belongs to the TAB, not the page,
    // so a reload reuses the same copy and only closing the tab clears it.
    // A tab opened before the merchandising engine ran kept serving the
    // pre-run order indefinitely - after a run that gave 76 products
    // neighbours for the first time, those tabs saw none of them, and
    // refreshing did not help because refreshing is not what clears it.
    //
    // There is no expiry that would have been right either: too short loses
    // the point, too long still serves a stale ranking. The edge caches this
    // response, so a request per page load is one warm round trip rather than
    // a saved copy of unknown age.
    try {
      sessionStorage.removeItem("badgehq-order");
      sessionStorage.removeItem("badgehq-order-v2");
      sessionStorage.removeItem("badgehq-order-v3");
      sessionStorage.removeItem("badgehq-order-v4");
    } catch (e) {
      /* private mode - nothing to clear */
    }
    // Reuse the request started at parse time where there is one, so this
    // does not pay for a round trip that is already in flight.
    (__bhqOrderPromise ||
      fetch(API_ORIGIN + "/api/order?shop=" + encodeURIComponent(SHOP)).then(
        function (r) {
          return r.json();
        },
      ))
      .then(function (d) {
        // handle -> the engine's own score, so the shopper's points are added
        // on the same scale the merchant's weights produced.
        var rank = {};
        var list = (d && d.order) || [];
        var sc = (d && d.scores) || [];
        var nb = (d && d.neighbours) || [];
        _neighbours = {};
        for (var ni = 0; ni < list.length; ni++) {
          if (nb[ni] && nb[ni].length) _neighbours[list[ni]] = nb[ni];
        }
        // Sent as indexes into the same list, so resolve them to handles.
        _outOfStock = {};
        var oos = (d && d.outOfStock) || [];
        for (var oi = 0; oi < oos.length; oi++) {
          var oh = list[oos[oi]];
          if (oh) _outOfStock[oh] = true;
        }
        // A payload with no scores array is an older cached one. Positions
        // are NOT a substitute: the shopper's points get added to this, and on
        // a positional scale a 20-point wishlist means twenty places, which is
        // what made one click jump to the top. Better to order by DOM position
        // for this page and pick the real scores up on the next load.
        var usable = sc.length === list.length;
        if (usable) {
          for (var i = 0; i < list.length; i++) rank[list[i]] = sc[i];
        }
        _orderRank = rank;
        try {
          // Only cache a payload worth reusing.
          // Both halves, or the next load restores an order with no affinity.
          if (usable) {
            sessionStorage.setItem(
              KEY,
              JSON.stringify({ r: rank, n: _neighbours, o: _outOfStock, t: d.runAt || 0 }),
            );
          }
        } catch (e2) {
          /* quota - it still works for this page */
        }
        then(rank);
      })
      .catch(function () {
        // No order available: fall back to DOM position, which is what the
        // grid already shows. Degrades to the previous behaviour rather than
        // leaving the page unsorted.
        _orderRank = {};
        __bhqUnveil();
        then(_orderRank);
      });
  }

  /**
   * Does this shopper need a different order from the one Shopify sent?
   *
   * The engine writes its ranking into the collection itself (sortOrder
   * MANUAL), so on a managed collection Shopify already serves products in
   * the right order and there is nothing to do. Re-sorting them anyway was
   * what the shopper saw as a shuffle: cards painted in the correct order and
   * then moved around the DOM to the same order.
   *
   * The only thing the server cannot know is this shopper's own behaviour,
   * which lives in sessionStorage. So the question is narrow: does their
   * behaviour change which products belong on this page? Usually it does not
   * - page-1 products outscore any behaviour bonus - and then the grid is
   * left exactly as it arrived.
   *
   * Returns the handles this page should show, or null to leave it alone.
   */
  function pageNeedsChange(cards, byHandle) {
    var rank = _orderRank || {};
    var onPage = {};
    for (var i = 0; i < cards.length; i++) onPage[cards[i].handle] = true;

    // The weakest card here sets the bar: a product only belongs on this page
    // if the shopper's interest lifts it above something already on it.
    var floor = Infinity;
    for (var c = 0; c < cards.length; c++) {
      var st = rank[cards[c].handle];
      if (typeof st === "number" && st < floor) floor = st;
    }
    if (floor === Infinity) return null;

    // Anything the shopper engaged with that now clears the bar but is not
    // here. Only those need fetching - typically none, at most one or two.
    var incoming = [];
    for (var h in byHandle) {
      if (onPage[h] || _outOfStock[h]) continue;
      var total = (typeof rank[h] === "number" ? rank[h] : 0) + byHandle[h];
      if (total > floor) incoming.push({ h: h, t: total });
    }

    // Nothing new wants in, so the only possible change is the order of what
    // is already here. Check that against the order it is already in rather
    // than assuming: if they match, the grid is left untouched.
    var want = [];
    for (var k = 0; k < cards.length; k++) {
      want.push({
        h: cards[k].handle,
        t:
          (typeof rank[cards[k].handle] === "number" ? rank[cards[k].handle] : -(k + 1)) +
          (byHandle[cards[k].handle] || 0) -
          (_outOfStock[cards[k].handle] ? OOS_PENALTY : 0),
        idx: k,
      });
    }
    for (var n = 0; n < incoming.length; n++) {
      want.push({ h: incoming[n].h, t: incoming[n].t, idx: 1e6 + n });
    }
    want.sort(function (a, b) {
      return b.t - a.t || a.idx - b.idx;
    });
    want = want.slice(0, cards.length);

    var same = true;
    for (var q = 0; q < want.length; q++) {
      if (want[q].h !== cards[q].handle) {
        same = false;
        break;
      }
    }
    if (same) return null;
    return want.map(function (x) {
      return x.h;
    });
  }

  /** How fast an engagement loses weight, in MINUTES.
   *
   *  Minutes, not hours, because the bag lives in sessionStorage and dies with
   *  the tab - everything being compared is from this visit, minutes apart. A
   *  14-hour half-life, the natural choice for a persistent profile, leaves a
   *  40-minute-old wishlist worth 96.8% of a fresh one: no useful ordering.
   *
   *  At 20 minutes, something touched a minute ago clearly leads something from
   *  the start of a long session, while two things touched within a few minutes
   *  stay effectively equal - which is right, since the shopper does not rank
   *  those either. Floored at 0.25 so an early interest still counts. */
  var DECAY_HALFLIFE_MIN = 20;

  /**
   * Read the behaviour bag and score it, fresh.
   *
   * Called again for every scroll batch rather than once per page load. The
   * scoring was inlined and its result captured in a closure, so a product
   * wishlisted after page 1 rendered could not influence page 2 - the most
   * recent engagement, the one that should matter most, was the one guaranteed
   * to be missed. Re-reading is cheap: sessionStorage is synchronous and the
   * bag holds at most 60 products.
   */
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

  /** Personalisation grows with engagement.
   *
   *  One touched product earns a light nudge; ten have told us enough to
   *  reorder firmly. The pull-in limit matters most: with ten engagements
   *  roughly 60 boosted products sit off page 1 competing for slots, so a fixed
   *  3 discarded almost all of the signal. Each extra slot costs one card fetch
   *  (~19KB), which is why this scales with evidence rather than starting high. */
  function maturityFor(count) {
    if (count <= 2) return { share: 0.4, pull: 4 };
    if (count <= 5) return { share: 0.55, pull: 6 };
    return { share: 0.7, pull: 8 };
  }

  function reorderGridForShopper(page, weights) {
    // The veil is only ever raised once a change has been decided, so an
    // early exit has nothing to release - the grid was never hidden.
    function release() {
      __bhqUnveil();
    }
    // Nothing to reorder on this page, so stop hiding it. Every exit below
    // does the same: the veil exists to cover a reorder, and a grid held back
    // for a reorder that is not coming is just a blank grid.
    if (page !== "collection" && page !== "home") return release();

    // Defaults match the old constants, so a shop that has never touched the
    // sliders behaves exactly as before.
    var W = {
      cart: num(weights && weights.cart, 12),
      wish: num(weights && weights.wish, 10),
      dwell: num(weights && weights.dwell, 5),
      views: num(weights && weights.views, 1),
    };

    // A filtered or explicitly sorted view is the shopper asking for a
    // specific order. Overriding it would be wrong.
    var qs = window.location.search;
    if (/[?&](filter\.|sort_by=)/.test(qs)) return release();

    /**
     * Install the scroll-page rewriter.
     *
     * Armed whenever the ranked order is available, regardless of whether this
     * shopper had any behaviour when the page loaded. It used to be assigned
     * only on the branch taken when behaviour already existed, so a shopper who
     * landed with an empty bag - everyone, on their first page - never got a
     * rewriter, and wishlisting afterwards did not arm one either: this
     * function runs once per page load and had already returned.
     *
     * That is why wishlisting on page 1 and then scrolling produced nothing.
     * The per-batch re-scoring inside the rewriter was written for exactly that
     * case and was never reached, because the rewriter did not exist.
     *
     * Safe to arm unconditionally: it returns the page untouched when there is
     * no behaviour to act on.
     */
    /**
     * Fetch the cards the next scroll page will lead with, now.
     *
     * A scroll page costs the shopper two waits in sequence: ~284ms for
     * Shopify to return the page, then ~181ms more while the cards that
     * belong at the top of it are fetched. The second wait is avoidable -
     * which cards those are is known the moment the shopper engages, and
     * they are usually reading page 1 for several seconds before they
     * scroll at all.
     *
     * Fetched into the same sessionStorage cache rebuildScrollPage reads, so
     * a prefetched card comes back synchronously and the scroll costs only
     * Shopify's own page fetch.
     *
     * Deliberately idle work: it runs behind requestIdleCallback where the
     * browser has one, so it never competes with the page the shopper is
     * actually looking at.
     */
    /**
     * Start loading the next scroll page while the shopper is still reading.
     *
     * The theme triggers its own load at 200px from the bottom. On a phone
     * that is less than half a screen of warning, and Shopify needs roughly a
     * second to answer over a slow connection - so the shopper reaches the end
     * of the grid and waits, every single page.
     *
     * This watches for them passing 60% of the page and starts the same
     * request then, storing the response. When the theme finally asks, the
     * hook hands back what is already here.
     *
     * One page ahead only. Two would mean fetching ~150KB the shopper may
     * never scroll to, which on a metered connection is their money.
     */
    /**
     * Warm the images the next page will show first.
     *
     * The HTML was the smaller half of the problem. A scroll page is ~10KB
     * gzipped but carries 24 product images at ~58KB each - around 1.4MB, or
     * seven seconds on the connection most of these shoppers have. Every one
     * is loading="lazy", so none of them even starts until the card is on
     * screen, and the shopper watches grey boxes fill in.
     *
     * Only the first two rows are warmed. Those are what they see when the
     * page appears; the rest arrive while they scroll past the first. Warming
     * all 24 would be 1.4MB the shopper may never look at, which on a metered
     * connection is their money.
     *
     * The browser is doing the caching here: an Image() for a URL the page
     * will later request means the second request is served from the HTTP
     * cache. Images, unlike the section HTML, are cacheable.
     */
    function prefetchPageImages(html) {
      try {
        if (!html) return;
        // Parsed rather than regexed for the src alone: a card offers seven
        // widths through srcset, and the browser picks one using sizes. Just
        // warming the src downloads width=533 (~58KB) when the card will
        // actually request width=360 (~31KB) on a phone - so the prefetch
        // cost almost twice what it saved, and missed the cache anyway.
        var tpl = document.createElement("template");
        tpl.innerHTML = html;
        var imgs = tpl.content.querySelectorAll("img");
        var picked = [];
        for (var i = 0; i < imgs.length && picked.length < IMG_PREFETCH_COUNT; i++) {
          var src = imgs[i].getAttribute("src") || "";
          if (src.indexOf("/cdn/shop/") === -1) continue;
          picked.push({
            src: src,
            srcset: imgs[i].getAttribute("srcset") || "",
            sizes: imgs[i].getAttribute("sizes") || "",
          });
        }
        if (!picked.length) return;

        var n = 0;
        var next = function () {
          if (n >= picked.length) return;
          var p2 = picked[n++];
          var im = new Image();
          // Lowest priority: this is for a page the shopper has not asked
          // for and must not compete with the one they are reading.
          if ("fetchPriority" in im) im.fetchPriority = "low";
          im.onload = im.onerror = function () {
            idle(next);
          };
          // sizes before srcset: the browser resolves the candidate when
          // srcset is set, and needs sizes in place to resolve it the same
          // way the real card will.
          if (p2.sizes) im.sizes = p2.sizes;
          if (p2.srcset) im.srcset = p2.srcset;
          im.src = p2.src;
        };
        idle(next);
      } catch (e) {
        /* a warm cache is a bonus, never a requirement */
      }
    }

    /** URL a scroll listener is already armed for. */
    var _armedFor = null;

    function prefetchNextPage() {
      // The theme carries the next URL on its own scroll trigger, and every
      // appended page brings an updated one. rel="next" does not: it is the
      // document's own head and always says page 2, so prefetching from it
      // worked once and then handed back a stale page for every later
      // scroll - the shopper got the full wait back from page 3 onward.
      var trigger = document.querySelector('[id^="infinite-scroll-trigger"]');
      var nextUrl =
        (trigger && (trigger.getAttribute("data-next-page") || trigger.getAttribute("data-next-url"))) ||
        (document.querySelector('link[rel="next"], a[rel="next"]') || {}).href ||
        "";
      if (!nextUrl) return;

      var grid = document.querySelector("#product-grid");
      var section = grid && grid.closest('[id^="shopify-section-"]');
      var sectionId = section ? section.id.replace("shopify-section-", "") : "";
      if (!sectionId) return;
      var full =
        nextUrl + (nextUrl.indexOf("?") === -1 ? "?" : "&") + "section_id=" + sectionId;
      // Guarded before a listener is armed, not only once a fetch has
      // fired. The old guard let every call add another scroll listener,
      // each with its own fired flag, so one scroll event fired all of
      // them: page 2 was requested 29 times and the theme waited 4.7s for
      // the last copy, which is slower than having no prefetch at all.
      if (__bhqPagePrefetch[full] || _armedFor === full) return;
      _armedFor = full;

      var fired = false;
      var maybe = function () {
        if (fired) return;
        // Measured against the GRID, not the document. Once four pages are
        // appended the document is long enough that 60% of it still leaves
        // the shopper far from the end, and the prefetch fires too late to
        // have finished.
        var g = document.querySelector("#product-grid");
        if (!g) return;
        var rect = g.getBoundingClientRect();
        var remaining = rect.bottom - window.innerHeight;
        // Roughly two screens of grid left to read.
        if (remaining > window.innerHeight * 2) return;
        fired = true;
        window.removeEventListener("scroll", maybe);
        // Raw fetch: through the hook this page would be rewritten now and
        // again on serve, and the second pass would discard the first's
        // choices as already shown.
        __bhqPagePrefetch[full] = (window.__bhqRawFetch || fetch)(full, {
          credentials: "same-origin",
        })
          .then(function (res) {
            if (!res.ok) throw new Error("bad status");
            return res.text();
          })
          .then(function (html) {
            prefetchPageImages(html);
            return html;
          });
        __bhqPagePrefetch[full].catch(function () {
          delete __bhqPagePrefetch[full];
        });
      };
      window.addEventListener("scroll", maybe, { passive: true });
      maybe();
    }

    /** Coming back from a product page restores this page from the bfcache
     *  rather than reloading it, so the view and dwell recorded over there
     *  are in storage while this page's state is still the old one. */
    function watchBackNavigation() {
      window.addEventListener("pageshow", function (e) {
        if (e.persisted && __bhqOnEngage) __bhqOnEngage();
      });
    }

    /**
     * Re-arm the page prefetch each time the theme appends a page.
     *
     * prefetchNextPage ran once, on load, and its scroll listener removed
     * itself after firing - so only page 2 was ever prefetched and every
     * page from 3 onward paid the full wait again. The theme rewrites its
     * trigger's data-next-page as each page lands, so watching that
     * attribute is what tells us a new page is available to prefetch.
     */
    function watchForNextPage() {
      if (!window.MutationObserver) return;
      var trigger = document.querySelector('[id^="infinite-scroll-trigger"]');
      var grid = document.querySelector("#product-grid");
      // The trigger where the theme has one; otherwise fall back to
      // watching the grid for appends, which is noisier but is the only
      // signal available.
      var target = trigger || (grid && grid.parentNode) || document.body;
      if (!target) return;
      new MutationObserver(function () {
        prefetchNextPage();
      }).observe(target, {
        // The trigger's attribute only. childList with subtree fired on
        // every insert anywhere under the grid - badges, wishlist hearts,
        // lazy images - and attributeFilter does not restrict those.
        attributes: true,
        attributeFilter: ["data-next-page", "data-next-url"],
        childList: !trigger,
        subtree: !trigger,
      });
    }

    /** Warm one card's image at the size the card will actually request. */
    function warmCardImage(card) {
      try {
        var src = card.querySelector && card.querySelector("img");
        if (!src) return;
        var im = new Image();
        if ("fetchPriority" in im) im.fetchPriority = "low";
        var ss = src.getAttribute("srcset");
        var sz = src.getAttribute("sizes");
        // sizes before srcset, so the browser resolves the same candidate
        // the card will.
        if (sz) im.sizes = sz;
        if (ss) im.srcset = ss;
        var s = src.getAttribute("src");
        if (s) im.src = s;
      } catch (e) {
        /* a warm cache is a bonus */
      }
    }

    /** Engagement generation: a later one cancels an earlier one's queue. */
    var _engageGen = 0;
    var _engageTimer = null;

    /**
     * Re-warm everything the shopper just made relevant.
     *
     * Prefetching only happened on page load, when the behaviour bag is empty
     * for most shoppers - so a wishlist click warmed nothing and all eight
     * lead cards were fetched at scroll time, which is the one moment that
     * had to be instant.
     *
     * Debounced because a single tap can produce several bumps, and
     * generation-guarded because unwishlisting should stop the previous
     * queue rather than race it.
     *
     * Deliberately does NOT touch the current page. Reordering cards the
     * shopper is looking at is the shuffle this all started with; this only
     * affects what the next page will be.
     */
    function onEngagement() {
      clearTimeout(_engageTimer);
      _engageTimer = setTimeout(function () {
        if (!_orderRank) return;
        var gen = ++_engageGen;
        prefetchLeadCards(gen);
      }, 250);
    }

    function prefetchLeadCards(gen) {
      var live = scoreBehaviour(W);
      if (!live.length || !_orderRank) return;

      // Same similarity strength the lead slots sort on.
      var aff = {};
      for (var i = 0; i < live.length; i++) {
        var nr = _neighbours[live[i].handle];
        if (!nr) continue;
        for (var k = 0; k < nr.length; k++) {
          aff[nr[k]] = (aff[nr[k]] || 0) + live[i].score * (1 - k / nr.length);
        }
      }

      // Only what is not already on screen: anything the shopper can see
      // will not be fetched for a later page either.
      var onPage = {};
      try {
        var links = document.querySelectorAll('#product-grid a[href*="/products/"]');
        for (var li = 0; li < links.length; li++) {
          var lm = (links[li].getAttribute("href") || "").match(/\/products\/([^/?#]+)/);
          if (lm) onPage[decodeURIComponent(lm[1]).toLowerCase()] = true;
        }
      } catch (e) {
        /* fall through - a prefetch of something already shown is wasteful,
           not wrong */
      }

      var cands = [];
      for (var h in aff) {
        if (onPage[h] || _outOfStock[h]) continue;
        if (typeof _orderRank[h] !== "number") continue;
        cands.push({ h: h, s: aff[h] });
      }
      cands.sort(function (a, b) {
        return b.s - a.s;
      });

      // Only as many as a page can actually lead with.
      var want = cands.slice(0, Math.ceil(PAGE_SIZE / 3));
      var idx = 0;
      // Two at a time rather than one. Serially, seven cards took ~1.2s on
      // a fast connection and about four seconds at 300ms latency - long
      // enough that a shopper scrolling sooner makes the rewrite fetch the
      // rest itself. Two keeps the latency cost down without crowding out
      // the images on the page being read.
      var inFlight = 0;
      var step = function () {
        // Checked on entry, so two requests are in flight at most. Testing
        // it after incrementing allowed a third through.
        if (inFlight >= 2) return;
        // A newer engagement has superseded this queue - unwishlisting,
        // say - so stop fetching cards for what the shopper no longer
        // wants.
        if (gen !== undefined && gen !== _engageGen) return;
        if (idx >= want.length) return;
        var h2 = want[idx++].h;
        var isFirstRow = idx <= EAGER_ROW_COUNT;
        inFlight++;
        fetchCardFor(h2, null, function (card) {
          inFlight--;
          // The cards that will lead the next page are the ones whose
          // images the shopper sees first, so warm those too.
          if (card && isFirstRow) warmCardImage(card);
          idle(step);
        });
        step();
      };
      idle(step);
    }

    function armPageRewriter() {
    // Arm the page rewriter now the ranked order is loaded. Until this
    // point the hook installed at parse time passes every response straight
    // through, because there is nothing to rebuild a page with.
    //
    // This is what lifts the Shopify limit: a page is no longer ranks 25-48
    // of one fixed order, it is whichever 24 products this shopper should
    // see at that depth - including ones Shopify would have put on page 30.
    __bhqPageRewriter = function (url, html, finish) {
      var m = url.match(/[?&]page=(\d+)/);
      var pageNo = m ? parseInt(m[1], 10) : 1;
      if (!(pageNo > 1)) return finish(html);

      // Shopify paginates the order the engine already wrote, so page N
      // of a managed collection is page N of our own ranking. Rebuilding
      // it only reshuffles it into the order it arrived in - visibly, on
      // every scroll - and costs a card fetch per swapped slot.
      //
      // Left alone unless this shopper has behaviour that actually
      // changes which products belong at this depth.
      // Re-scored per batch, not read from the closure. wanted was fixed
      // when the page loaded, so a product wishlisted while the shopper
      // read page 1 had no effect on page 2 - the most recent engagement
      // was the one guaranteed to be ignored.
      var live = scoreBehaviour(W);
      if (!live.length) return finish(html);

      // Page 1 is rendered by Shopify and never passes through buildPage,
      // so its products were not in the shown record and page 2 could
      // repeat any of them - which is what put the same crop top twice in
      // one row. Read off the live grid, because by now the client-side
      // reorder may have changed which products are on it.
      var onPage = document.querySelectorAll('a[href*="/products/"]');
      for (var oi = 0; oi < onPage.length; oi++) {
        var hm = onPage[oi].getAttribute("href").match(/\/products\/([^/?#]+)/);
        if (hm) _shown[decodeURIComponent(hm[1]).toLowerCase()] = true;
      }

      // What the shopper has earned so far, same scale the sort uses.
      var byHandle = {};
      for (var wi = 0; wi < live.length; wi++) {
        byHandle[live[wi].handle] = (byHandle[live[wi].handle] || 0) + live[wi].score;
      }
      // Affinity on those fresh scores, so a near match of something just
      // engaged with can reach this batch rather than waiting for a
      // reload. Strength and reach grow with how much the shopper has
      // told us - this is what makes each page better than the last.
      var mat = maturityFor(live.length);
      var aff = {};
      for (var li2 = 0; li2 < live.length; li2++) {
        var nr = _neighbours[live[li2].handle];
        if (!nr) continue;
        for (var nk = 0; nk < nr.length; nk++) {
          aff[nr[nk]] = (aff[nr[nk]] || 0) + live[li2].score * mat.share * (1 - nk / nr.length);
        }
      }
      // Same two ceilings as page 1: against the product's own
      // engagement, and against the strongest single engagement, so
      // accumulated affinity never outranks something actually touched.
      // Similarity strength on its own, for the lead slots. Same falloff
      // down each neighbour list, but not capped against the engagement
      // and never added to the score.
      _affinityRank = {};
      for (var fi = 0; fi < live.length; fi++) {
        var fnr = _neighbours[live[fi].handle];
        if (!fnr) continue;
        for (var fk = 0; fk < fnr.length; fk++) {
          _affinityRank[fnr[fk]] =
            (_affinityRank[fnr[fk]] || 0) + live[fi].score * (1 - fk / fnr.length);
        }
      }
      var topLive = live.length ? live[0].score : 0;
      for (var ak in aff) {
        var ownLive = byHandle[ak] || 0;
        byHandle[ak] =
          ownLive +
          Math.min(
            aff[ak],
            Math.min(ownLive > 0 ? ownLive * 0.8 : Infinity, topLive * 0.8),
          );
      }

      rebuildScrollPage(html, (pageNo - 1) * PAGE_SIZE, byHandle, RANDOMNESS, finish);
    };
    }

    // Scored by the shared helper so a scroll batch can recompute it from
    // whatever the shopper has done since this page loaded, and so the
    // recency weighting is applied in one place.
    var wanted = scoreBehaviour(W);
    // A first-time shopper has no behaviour yet, which is the common case on
    // a cold visit - and the case where holding the grid back buys nothing at
    // all, because there is no personalisation to wait for.
    //
    // The ranked order is still fetched and cached, though, which is the
    // whole point of doing it here. The app embed reorders the grid before
    // it paints using that cached order, so it has to be in storage BEFORE
    // the shopper engages - and the load where they engage is, by
    // definition, a load where they had no behaviour yet. Returning early
    // without caching made that impossible: the embed found nothing, bailed
    // out, and the reorder fell back to happening after first paint, in
    // view. Caching costs nothing here - the request is already in flight
    // from parse time.
    if (!wanted.length) {
      // Armed here too. A shopper with no behaviour yet still needs the
      // rewriter in place, because they may wishlist something while reading
      // page 1 and then scroll - and this function will not run again.
      loadOrderRank(function () {
        armPageRewriter();
        // Worth doing even with no behaviour: the next page still has to
        // be fetched, and fetching it early is the whole saving.
        prefetchNextPage();
        watchForNextPage();
        watchBackNavigation();
      watchBackNavigation();
        // This is the branch a first-time shopper takes, so this is exactly
        // the case where a later wishlist needs to warm its cards.
        __bhqOnEngage = onEngagement;
      });
      return release();
    }

    // Already sorted by scoreBehaviour, which applies the recency weighting
    // and breaks ties on which engagement is most recent.

    // Runs once the grid exists rather than on a timer: on a normal load the
    // markup is already parsed by the time widget.js executes, so the move
    // happens before the shopper has read the first row.
    loadOrderRank(function () {
      var tries = 0;
      (function attempt() {
        // Released on every path: a sorted grid, a grid that could not be
        // found, or a grid that was already in the right order.
        if (applyShopperOrder(wanted)) {
          __bhqUnveil();
          return;
        }
        if (++tries < 20) setTimeout(attempt, 150);
        else __bhqUnveil();
      })();

      armPageRewriter();
      // Both run while the shopper reads page 1, so the next scroll costs
      // them nothing: the page is already here and the cards that lead it
      // come back from storage without a request.
      prefetchNextPage();
      watchForNextPage();
      watchBackNavigation();
      prefetchLeadCards();
      // Re-run whenever the shopper engages, which is when it first has
      // anything to do.
      __bhqOnEngage = onEngagement;

      // The batch is sorted before it is inserted, not after.
      //
      // __bhqPageRewriter above intercepts the theme's own fetch for each
      // scroll page and rebuilds it in this shopper's order, so the cards
      // arrive correct and the browser paints them once.
      //
      // There used to be a MutationObserver here that re-sorted the same
      // cards 250ms after they landed. It was doing the rewriter's job a
      // second time, except in view: measured on the live site, every scroll
      // appended 24 cards and then tore down and rebuilt that block 350-500ms
      // later, moving 17-24 of the 24. That block is exactly where the
      // shopper is looking, so it read as a shuffle - and it only appeared
      // after a wishlist, because with no behaviour the re-sort produced the
      // same order and moved nothing.
      //
      // Removed rather than hidden or debounced faster: the sort it performed
      // had already happened.
    });
  }

  /** Is there a card for exactly this handle in the grid?
   *
   *  Parses each link rather than matching the handle as a substring: some
   *  handles here are prefixes of others, so a substring test reports the
   *  wrong product as present. */
  function handleOnPage(handle) {
    try {
      var links = document.querySelectorAll('#product-grid a[href*="/products/"]');
      for (var i = 0; i < links.length; i++) {
        var m = (links[i].getAttribute("href") || "").match(/\/products\/([^/?#]+)/);
        if (m && decodeURIComponent(m[1]).toLowerCase() === handle) return true;
      }
    } catch (e) {
      /* treat as absent: a wrong "present" silently drops a pull-in */
    }
    return false;
  }

  /** Find the <li>/<article> wrapping a card, given any element inside it. */
  function cardRootOf(el) {
    var n = el;
    for (var i = 0; i < 6 && n && n.parentElement; i++) {
      var tag = n.tagName;
      if (tag === "LI" || tag === "ARTICLE") return n;
      n = n.parentElement;
    }
    return null;
  }

  /**
   * Blend the shopper's own score into the merchandised order.
   *
   * The grid already arrives sorted by the server: best sellers first, then
   * reviews and newness. Each card is given that standing as a score - top
   * card highest - and the shopper's behaviour is added on top. Sorting by the
   * total means a wishlisted product climbs past the cards it has overtaken
   * and no further.
   *
   * This replaces pinning to position 1. A single click no longer reshuffles
   * the page: one action moves a product a few places, sustained interest
   * moves it to the front.
   */
  /**
   * Bring in a product the shopper wants that is not on this page.
   *
   * A card is built by cloning one the theme already rendered and swapping in
   * the new product's data, rather than asking the theme to render one. There
   * is no universal section for that - the pinned-card section this store has
   * is its own invention - but /products/<handle>.js exists on every Shopify
   * store and carries everything a card shows. Cloning also means the card
   * inherits the theme's own markup and styling for free.
   *
   * ~40KB per product against ~45KB for a single rendered card, and only for
   * the handful a shopper has actually touched.
   */
  /**
   * Bring in a product the shopper wants that this page did not load.
   *
   * Asks the THEME to render the card rather than building one. An earlier
   * version cloned a card already on the page and swapped its title, image and
   * price - but a card here is assembled by several apps after load (sale
   * badges, offer pills, the wishlist heart, an EMI widget), none of it in the
   * server HTML, so the clone wore the template product's offers. A shopper
   * reading "2 FOR 999" on a product not in that offer has been misled.
   *
   * A rendered card arrives without those either - they are added client-side -
   * but this storefront already runs several MutationObservers watching the
   * grid, so the apps decorate it themselves once it is inserted. The card ends
   * up identical to its neighbours instead of a stripped-down imitation.
   */
  var CARD_SECTIONS = ["pinned-card", "card-product", "product-card"];

  /** Cards kept in storage at once. At ~17KB each this caps the cache near
   *  700KB, well inside the ~5MB sessionStorage quota that the theme and
   *  every other app on the page also draw from. */
  var CARD_CACHE_MAX = 40;

  /**
   * Store a rendered card, evicting the oldest once the cache is full.
   *
   * Cards were written without any limit, so a shopper scrolling four pages
   * accumulated ~1.7MB of them. Once the quota is reached every write throws
   * and is swallowed, so the cache silently stops working and each scroll
   * refetches all eight cards - which is what pushes a rebuild past its
   * budget and serves the page without the products the shopper asked for.
   *
   * Insertion order is the eviction order. sessionStorage preserves it, and
   * the oldest card is the one furthest up the page.
   */
  function cacheCard(key, html) {
    try {
      var keys = [];
      for (var i = 0; i < sessionStorage.length; i++) {
        var k = sessionStorage.key(i);
        if (k && k.indexOf("badgehq-card-") === 0) keys.push(k);
      }
      while (keys.length >= CARD_CACHE_MAX) {
        sessionStorage.removeItem(keys.shift());
      }
      sessionStorage.setItem(key, html);
    } catch (e) {
      // Full anyway, or private mode. Drop every card and keep this one:
      // a cache that throws on every write is worse than an empty one.
      try {
        for (var j = sessionStorage.length - 1; j >= 0; j--) {
          var k2 = sessionStorage.key(j);
          if (k2 && k2.indexOf("badgehq-card-") === 0) sessionStorage.removeItem(k2);
        }
        sessionStorage.setItem(key, html);
      } catch (e2) {
        /* nothing more to do - the card still renders, just uncached */
      }
    }
  }

  function fetchCardFor(handle, template, then) {
    var CK = "badgehq-card-" + handle;
    try {
      var cached = sessionStorage.getItem(CK);
      if (cached) return then(cardFromHtml(cached));
    } catch (e) {
      /* private mode - just fetch */
    }

    // Section names are a theme convention, not a Shopify guarantee, so each
    // candidate is tried until one returns something card-shaped.
    var idx = 0;
    (function attempt() {
      if (idx >= CARD_SECTIONS.length) return then(null);
      var section = CARD_SECTIONS[idx++];
      fetch(
        "/products/" + encodeURIComponent(handle) + "?section_id=" + section,
        { credentials: "same-origin" },
      )
        .then(function (r) { return r.ok ? r.text() : Promise.reject(); })
        .then(function (html) {
          var card = cardFromHtml(html);
          if (!card) return attempt();
          try {
            cacheCard(CK, html);
          } catch (e2) {
            /* quota - it still works for this page */
          }
          then(card);
        })
        .catch(attempt);
    })();
  }

  /** The first product card in a section response, if it holds one. */
  function cardFromHtml(html) {
    var tpl = document.createElement("template");
    tpl.innerHTML = html;
    var el =
      tpl.content.querySelector("li.grid__item") ||
      tpl.content.querySelector("li, article, .card-wrapper, [class*='product-card']");
    if (!el) return null;
    // Must carry a product link, or it is a wrapper rather than a card.
    if (!el.querySelector('a[href*="/products/"]')) return null;
    el.setAttribute("data-badgehq-injected", "1");
    return el;
  }

  /**
   * Decide which products a scroll page shows, instead of accepting Shopify's.
   *
   * Shopify paginates the manual order it was given: page 2 is ranks 25-48, and
   * nothing can change that per shopper. A product at rank 700 could never
   * reach page 2 however well it matched, and the order was identical on every
   * reload for everyone.
   *
   * The theme fetches each page itself, so that fetch is intercepted and the
   * response treated as a supply of rendered cards rather than as the answer.
   * Whatever belongs in this slice is kept, the rest is fetched, and the page
   * is rebuilt in the order this shopper should see.
   *
   * Reusing what Shopify sent is the economy of it: a fully custom page is 24
   * card fetches at ~20KB each against one 150KB response, which on a phone is
   * a visible stall. In practice only a handful of slots differ.
   */
  var PAGE_SIZE = 24;
  /** Cap on how many slots a page may swap, so it stays mostly discovery
   *  rather than becoming an echo of what the shopper already saw. */
  var MAX_SWAPS = 8;
  /** How much the order is shuffled per load, as a fraction of a product's
   *  own score. 0 is deterministic; 0.06 reshuffles products that are
   *  genuinely close without letting a weak one overtake a strong one. */
  var RANDOMNESS = 0.06;
  /** Handles already placed on this page load, across every scroll page.
   *
   *  Each page takes a fresh slice of the ordering, and the ordering shifts
   *  as the shopper browses - a product that sat at rank 50 when page 3 was
   *  built can be at rank 30 by the time page 4 is, putting it in two slices.
   *  Shopify's own filler can repeat one too, since that is only deduped
   *  within a single page. Tracking what has been shown is the only thing
   *  that holds across both. */
  var _shown = {};
  /** Handles that cannot be bought right now.
   *
   *  The server orders in-stock first, but every sort here is on score so that
   *  ordering is lost - a sold-out product with a strong score takes a prime
   *  slot on page 1. Demoted rather than dropped: it still belongs in the
   *  collection, just not above things a shopper can actually add to a cart. */
  var _outOfStock = {};
  /** Pushed below every buyable product, while keeping sold-out products in
   *  score order among themselves. Larger than any real score (max observed
   *  567) plus the widest behaviour bonus, so the two bands never interleave. */
  var OOS_PENALTY = 100000;

  /** Per-load seed: the shuffle differs between reloads but is fixed within
   *  one load, so a card never moves while the shopper is reading it. */
  var _seed = Math.floor(Math.random() * 1e9);
  function jitter(handle) {
    var h = _seed;
    for (var i = 0; i < handle.length; i++) {
      h = (h * 31 + handle.charCodeAt(i)) & 0x7fffffff;
    }
    return (h % 1000) / 1000;
  }

  /** The products this shopper should see at a given depth, best first. */
  function pageSliceFor(offset, count, byHandle, randomness) {
    var rank = _orderRank || {};
    var all = [];
    for (var h in rank) {
      var base = rank[h] + (byHandle[h] || 0);
      // Scaled to the score, so the nudge is proportionate: it reshuffles
      // products that are genuinely close and never lifts a weak one over a
      // strong one.
      if (randomness > 0) base += jitter(h) * Math.abs(base) * randomness;
      // After the jitter, never before: the nudge is a fraction of the score's
      // own size, so applying it to a penalised score would scale it against
      // 100000 and hand out a swing big enough to lift a sold-out product
      // back over the buyable ones it was just demoted below.
      if (_outOfStock[h]) base -= OOS_PENALTY;
      all.push({ h: h, s: base });
    }
    all.sort(function (a, b) {
      return b.s - a.s;
    });
    // Skip what is already on the page rather than slicing blindly: the
    // ordering shifts between pages, so a fixed offset can hand back a
    // product an earlier page already used. Walking past them also keeps
    // the page full instead of leaving gaps where duplicates were dropped.
    // No offset. Skipping what is shown ALREADY advances past every earlier
    // page, so also skipping `offset` entries skipped them twice - page 3
    // came back with four products instead of twenty-four. The record is
    // the position now.
    var out = [];

    // The most similar products lead the page, by reservation rather than
    // by score.
    //
    // Boosting could not do this. A shopper wishlisting five block heels
    // leaves a bestselling tee on 404 while the heels they want sit on 330:
    // measured on this catalogue, even a 180-point boost only moved apparel
    // from four cards on page 1 to three, because the gap is in the global
    // score and the boost is additive. Demoting the tee was the other way
    // and is not wanted - it punishes a product for being popular.
    //
    // So the global score keeps deciding the page, and similarity decides
    // only who goes FIRST on it. Nothing is pushed down the collection;
    // what the shopper has shown interest in is simply served earlier.
    var lead = [];
    if (_affinityRank) {
      var cands = [];
      for (var ch in _affinityRank) {
        if (_shown[ch] || _outOfStock[ch]) continue;
        if (typeof rank[ch] !== "number") continue;
        cands.push({ h: ch, s: _affinityRank[ch] });
      }
      // Strongest similarity first, not highest score: the point is which
      // product is most like what they engaged with.
      cands.sort(function (a, b) {
        return b.s - a.s;
      });
      // A fraction of the page, never all of it. A page made entirely of
      // near-matches stops being a collection and the shopper sees the same
      // shoe twelve times; the rest of the page stays discovery.
      var room = Math.min(cands.length, Math.ceil(count / 3));
      for (var ci = 0; ci < room; ci++) {
        lead.push(cands[ci].h);
        out.push(cands[ci].h);
      }
    }

    // Then the page as the global ranking would have it, skipping anything
    // already led with.
    for (var i = 0; i < all.length && out.length < count; i++) {
      if (_shown[all[i].h]) continue;
      if (lead.indexOf(all[i].h) !== -1) continue;
      out.push(all[i].h);
    }
    return out;
  }

  /** Rewrite a scroll page so it holds the products this shopper should see. */
  function rebuildScrollPage(html, offset, byHandle, randomness, then) {
    var tpl = document.createElement("template");
    tpl.innerHTML = html;
    var cards = tpl.content.querySelectorAll("li");
    if (cards.length < 2 || !_orderRank) return then(html);

    // What Shopify sent, indexed by handle: a supply of rendered cards.
    var supply = {};
    for (var i = 0; i < cards.length; i++) {
      var a = cards[i].querySelector('a[href*="/products/"]');
      if (!a) continue;
      var m = a.getAttribute("href").match(/\/products\/([^/?#]+)/);
      if (m) supply[decodeURIComponent(m[1]).toLowerCase()] = cards[i];
    }

    var want = pageSliceFor(offset, PAGE_SIZE, byHandle, randomness);
    var keep = [];
    var fetchList = [];
    for (var w = 0; w < want.length; w++) {
      if (supply[want[w]]) keep.push({ h: want[w], el: supply[want[w]] });
      else if (fetchList.length < MAX_SWAPS) fetchList.push(want[w]);
    }
    // Anything Shopify sent that this shopper does not want, kept as filler so
    // a page never comes back short.
    var filler = [];
    for (var sh in supply) {
      if (want.indexOf(sh) === -1) filler.push({ h: sh, el: supply[sh] });
    }

    if (!fetchList.length) return then(buildPage(keep, filler, tpl));

    var pending = fetchList.length;
    var fetched = [];
    fetchList.forEach(function (h) {
      fetchCardFor(h, null, function (card) {
        if (card) fetched.push({ h: h, el: card });
        if (--pending !== 0) return;
        // Assembled in the order the shopper should see them.
        var merged = [];
        for (var k = 0; k < want.length; k++) {
          var hit = null;
          for (var f = 0; f < fetched.length && !hit; f++) {
            if (fetched[f].h === want[k]) hit = fetched[f];
          }
          for (var kk = 0; kk < keep.length && !hit; kk++) {
            if (keep[kk].h === want[k]) hit = keep[kk];
          }
          if (hit) merged.push(hit);
        }
        then(buildPage(merged, filler, tpl));
      });
    });
  }

  /** Put the chosen cards back into the response the theme expects. */
  function buildPage(chosen, filler, tpl) {
    var grid = tpl.content.querySelector("ul");
    if (!grid) return tpl.innerHTML;
    while (grid.firstChild) grid.removeChild(grid.firstChild);
    var n = 0;
    for (var i = 0; i < chosen.length && n < PAGE_SIZE; i++) {
      if (_shown[chosen[i].h]) continue;
      _shown[chosen[i].h] = true;
      grid.appendChild(chosen[i].el);
      n++;
    }
    // Topped up from what Shopify sent, so a page is never short. Checked
    // against the same record: filler was the other way a product could
    // appear twice, since Shopify's page 3 can contain what its page 2 did
    // once we have reordered them.
    for (var j = 0; j < filler.length && n < PAGE_SIZE; j++) {
      if (_shown[filler[j].h]) continue;
      _shown[filler[j].h] = true;
      grid.appendChild(filler[j].el);
      n++;
    }

    // The first row loads immediately rather than lazily.
    //
    // Every card Shopify renders carries loading="lazy", so nothing on an
    // appended page starts loading until it scrolls into view - and the
    // top of a new page is in view the moment it is appended. The shopper
    // watches the first row fill in when it could have started already.
    //
    // Only the first row: lazy loading is right for the other twenty.
    try {
      var firstRow = grid.querySelectorAll("li");
      for (var e = 0; e < Math.min(firstRow.length, EAGER_ROW_COUNT); e++) {
        var im = firstRow[e].querySelector("img");
        if (!im) continue;
        im.setAttribute("loading", "eager");
        im.setAttribute("fetchpriority", "high");
      }
      // Every image on the page decodes off the main thread. Without this
      // a batch of 24 decodes synchronously as the page is appended, which
      // is what makes the scroll catch on a low-end phone.
      var all = grid.querySelectorAll("img");
      for (var d = 0; d < all.length; d++) {
        all[d].setAttribute("decoding", "async");
      }
    } catch (e2) {
      /* the page still works, just lazily */
    }
    return tpl.innerHTML;
  }

  function applyShopperOrder(wanted, batchOnly) {
    // Reuse the wishlist's card selectors: they already cover Dawn and the
    // other themes this app runs on, and they are maintained in one place.
    var cards = [];
    for (var s = 0; s < WL_CARD_SELECTORS.length && !cards.length; s++) {
      var found = document.querySelectorAll(WL_CARD_SELECTORS[s]);
      for (var i = 0; i < found.length; i++) {
        var root = cardRootOf(found[i]);
        var handle = wlHandleFromLink(found[i]);
        if (root && handle) cards.push({ root: root, handle: handle.toLowerCase() });
      }
    }
    if (cards.length < 2) return false;

    var grid = cards[0].root.parentElement;
    // A later batch sorts only its own cards. Everything placed by an earlier
    // pass is marked settled and left exactly where the shopper last saw it.
    if (batchOnly) {
      cards = cards.filter(function (c) {
        return !c.root.getAttribute("data-badgehq-settled");
      });
      if (cards.length < 2) return true;
    }
    if (!grid) return false;
    cards = cards.filter(function (c) {
      return c.root.parentElement === grid;
    });
    if (cards.length < 2) return false;

    var byHandle = {};
    // Affinity: a shopper who engaged with one product is interested in the
    // ones like it, even if they never saw them. Each engaged product passes
    // a share of its own score to its precomputed near matches.
    //
    // Only a share - a neighbour is evidence of taste, not of intent, and a
    // product the shopper actually wishlisted must still outrank one merely
    // similar to it. Capped so a long tail of neighbours cannot add up to
    // more than the engagement that produced them.
    // Both scale with how much the shopper has told us.
    var _mat = maturityFor(wanted.length);
    var AFFINITY_SHARE = _mat.share;
    var AFFINITY_CAP = 0.8;
    var affinity = {};
    for (var ai = 0; ai < wanted.length; ai++) {
      var near = _neighbours[wanted[ai].handle];
      if (!near) continue;
      for (var nj = 0; nj < near.length; nj++) {
        var h2 = near[nj];
        // Decays down the list: the closest match earns the most.
        var falloff = 1 - nj / near.length;
        affinity[h2] = (affinity[h2] || 0) + wanted[ai].score * AFFINITY_SHARE * falloff;
      }
    }

    // Summed, not assigned. One product can hold two entries in the bag: a
    // product-page view keys by id where the theme exposes one, while a
    // wishlist click on a card keys by handle. Both carry the same handle, so
    // assigning would let whichever came last erase the other - a shopper who
    // viewed AND wishlisted a product would be credited for only one of them.
    for (var wi = 0; wi < wanted.length; wi++) {
      var wh = wanted[wi].handle;
      byHandle[wh] = (byHandle[wh] || 0) + wanted[wi].score;
    }
    // Added after, and capped against the product's own engagement, so a
    // product the shopper touched is never overtaken by one merely like it.
    // Two ceilings. Against the product's own engagement, so something the
    // shopper touched is never overtaken by something merely like it. And
    // against the STRONGEST single engagement, because affinity accumulates:
    // a product that happens to be the near match of five engaged products
    // would otherwise out-score a cart add it has nothing to do with.
    var strongest = 0;
    for (var si = 0; si < wanted.length; si++) {
      if (wanted[si].score > strongest) strongest = wanted[si].score;
    }
    for (var ah in affinity) {
      var own = byHandle[ah] || 0;
      var ceiling = Math.min(
        own > 0 ? own * AFFINITY_CAP : Infinity,
        strongest * AFFINITY_CAP,
      );
      byHandle[ah] = own + Math.min(affinity[ah], ceiling);
    }


    // Products the shopper wants that this page did not load. Without this
    // the sort can only rearrange what is already there, so a wishlisted
    // product on page 20 of a 1,059-product collection stays invisible however
    // high it scores. Capped: a handful is the point, not a second grid.
    var present = {};
    for (var pi = 0; pi < cards.length; pi++) present[cards[pi].handle] = true;
    // Everything else on the page counts as present too, not just this
    // batch. cards holds only what is being sorted, so a product sitting on
    // page 1 was invisible to this check while page 2 was processed and got
    // pulled in a second time - the wishlisted boot appeared at both slot 15
    // and 16, pushing every card below it down one.
    //
    // Read from the links rather than our own data attribute: a card
    // Shopify rendered does not carry one, which is exactly the case that
    // slipped through.
    try {
      var links = document.querySelectorAll('#product-grid a[href*="/products/"]');
      for (var li = 0; li < links.length; li++) {
        var lm = (links[li].getAttribute("href") || "").match(/\/products\/([^/?#]+)/);
        if (lm) present[decodeURIComponent(lm[1]).toLowerCase()] = true;
      }
    } catch (e) {
      /* fall back to the batch-only view */
    }
    // Candidates come from byHandle, not from wanted. wanted holds only what
    // the shopper touched directly, so affinity could never pull in a
    // neighbour: of five products similar to a wishlisted boot, the one
    // already on page 1 moved up three places and the four sitting at 62,
    // 109, 460 and 707 stayed invisible. byHandle carries the affinity
    // boosts too, so a near match deep in the collection can be fetched.
    //
    // Ordered by score so the three slots go to the strongest candidates
    // rather than whichever the bag happened to list first.
    var candidates = [];
    for (var ch in byHandle) {
      if (!present[ch] && byHandle[ch] > 0) candidates.push({ h: ch, s: byHandle[ch] });
    }
    candidates.sort(function (a2, b2) {
      return b2.s - a2.s;
    });
    // Grows with engagement. At a fixed 3, a shopper with ten wishlists had
    // ~60 boosted products off page 1 competing for the slots and 57 were
    // never fetched at all.
    var missing = candidates.slice(0, _mat.pull).map(function (c) {
      return c.h;
    });
    // Injection is attempted ONCE per page. The re-sort that follows an
    // injection calls straight back into this function, and an injected card
    // is not always matched by the selector pass above - so "still missing"
    // stayed true, it injected again, and each pass appended another copy
    // until the grid was one product repeated sixteen times.
    //
    // A latch rather than a guard: _injecting only covered the window while
    // fetches were in flight, and the loop ran after it had been cleared.
    if (missing.length && !_injectedOnce) {
      _injectedOnce = true;
      var pending = missing.length;
      missing.forEach(function (h) {
        // Belt and braces: a card for this handle may have landed from an
        // earlier pass even if the selector did not pick it up.
        // Matches a Shopify-rendered card as well as one of ours: the
        // data attribute is only on cards this widget injected.
        //
        // Compared on the WHOLE handle, not as a substring. This shop has
        // handles that are prefixes of each other -
        // "...block-heel-sandals" and "...block-heel-sandals-for-women" -
        // so a href*= test found the second card and wrongly reported the
        // first as already present, silently dropping its pull-in.
        if (
          document.querySelector('[data-badgehq-handle="' + h + '"]') ||
          handleOnPage(h)
        ) {
          if (--pending === 0) applyShopperOrder(wanted);
          return;
        }
        fetchCardFor(h, null, function (card) {
          if (card) {
            // Tagged with its handle so a later pass can recognise it
            // whatever the theme card selectors happen to match.
            card.setAttribute("data-badgehq-handle", h);
            // Marked as pulled-in so the sort leaves it where it is put.
            // Re-ranking it defeats the fetch: these sit at 62, 109 and 707
            // in the merchandised order, and a few points of affinity never
            // closes a 35-point gap to the weakest card on the page - so they
            // were landing at 25, 26 and 27, below everything, after being
            // fetched precisely because they were worth showing.
            card.setAttribute("data-badgehq-pulled", "1");
            grid.appendChild(card);
          }
          // Re-sort once they have all answered: the new cards are appended at
          // the end, and the sort is what puts them where they belong.
          if (--pending === 0) applyShopperOrder(wanted);
        });
      });
      // Fall through and sort what is here now; the callback sorts again when
      // the fetched cards land, so the page is never left waiting on a network
      // round trip to look right.
    }

    // The engine's own score for each card, plus the shopper's points. Same
    // scale, so a wishlist worth 20 means 20 of the engine's points - which
    // near the top of a collection is a place or two, and further down is
    // more, because that is where products actually sit close together.
    //
    // Ranking by POSITION instead made 20 points mean 20 places regardless,
    // so a single wishlist leapt past products scoring hundreds higher.
    var rank = _orderRank || {};
    // Decide the list before touching anything. On a collection the engine
    // manages, Shopify has already applied this exact order, so this
    // normally returns null and the grid is left as it was painted - which
    // is the whole point: nothing moves, so there is nothing to see move.
    // Appended batches get the same treatment as the first page. They were
    // exempt, which is why scrolling still shuffled after the first screen
    // was fixed: each new batch arrived in the server order and was then
    // re-sorted into that same order, in view, on every scroll.
    // Nothing to do, so release whatever the parse-time check raised. An
    // engaged shopper whose order happens to match is still hidden at this
    // point and must not be left that way.
    if (pageNeedsChange(cards, byHandle) === null) {
      __bhqUnveil();
      return true;
    }
    // No veil is raised here: it went up before the first paint, because by
    // this point the grid is already on screen and hiding it now would
    // blink it to blank rather than cover anything.

    var ranked = cards.map(function (c, idx) {
      var base = rank[c.handle];
      // Unranked products keep their place rather than sinking: a new
      // product the engine has not scored yet is not a bad product.
      var standing = typeof base === "number" ? base : -(idx + 1);
      return {
        root: c.root,
        idx: idx,
        handle: c.handle,
        // Sold-out products sink below every buyable one. Applied here rather
        // than by filtering, so they keep their place among themselves.
        total:
          standing +
          (byHandle[c.handle] || 0) -
          (_outOfStock[c.handle] ? OOS_PENALTY : 0),
      };
    });

    var changed = false;
    ranked.sort(function (a, b) {
      if (b.total !== a.total) return b.total - a.total;
      return a.idx - b.idx; // equal interest keeps the merchandised order
    });
    for (var r = 0; r < ranked.length; r++) {
      if (ranked[r].idx !== r) { changed = true; break; }
    }
    if (!changed) return true;

    // Pulled-in cards are lifted out of the ranking and re-inserted directly
    // after the product that earned them, which is the whole proposition:
    // you wishlisted this, so here are ones like it.
    var pulled = [];
    var sorted = [];
    for (var pk = 0; pk < ranked.length; pk++) {
      if (ranked[pk].root.getAttribute("data-badgehq-pulled")) pulled.push(ranked[pk]);
      else sorted.push(ranked[pk]);
    }
    if (pulled.length) {
      // After the highest-scoring product the shopper actually engaged with.
      var anchor = -1;
      for (var si2 = 0; si2 < sorted.length; si2++) {
        if (byHandle[sorted[si2].handle] > 0 && !sorted[si2].root.getAttribute("data-badgehq-pulled")) {
          anchor = si2;
          break;
        }
      }
      // Trim from the end so the grid keeps its length and the last row of
      // the theme's column layout stays full.
      var trimmed = sorted.splice(Math.max(sorted.length - pulled.length, 0), pulled.length);
      for (var tk = 0; tk < trimmed.length; tk++) {
        if (trimmed[tk].root.parentNode) trimmed[tk].root.parentNode.removeChild(trimmed[tk].root);
      }
      sorted.splice(anchor >= 0 ? anchor + 1 : 0, 0, ...pulled);
      ranked = sorted;
    }

    // Appended in order into a fragment, so the grid is touched once rather
    // than per card - a card at a time would force a reflow on each move.
    var frag = document.createDocumentFragment();
    for (var k = 0; k < ranked.length; k++) {
      ranked[k].root.setAttribute("data-badgehq-settled", "1");
      frag.appendChild(ranked[k].root);
    }
    // A later batch belongs after what is already on screen; only the first
    // pass may touch the top of the grid.
    if (batchOnly) grid.appendChild(frag);
    else grid.insertBefore(frag, grid.firstElementChild);
    // Released on the same frame the cards land, so the grid is revealed
    // already in its final order.
    __bhqUnveil();
    return true;
  }
})();
