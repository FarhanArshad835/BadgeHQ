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

  var APP_ORIGIN = "";
  if (scriptEl && scriptEl.src) {
    try {
      var u = new URL(scriptEl.src);
      APP_ORIGIN = u.origin;
    } catch (e) {
      // fallback: strip /widget.js from the src
      APP_ORIGIN = scriptEl.src.replace(/\/widget\.js(\?.*)?$/, "");
    }
  }

  var API_URL = APP_ORIGIN
    ? APP_ORIGIN + "/api/widgets?shop=" + encodeURIComponent(SHOP)
    : "/apps/badgehq/api/widgets?shop=" + encodeURIComponent(SHOP);

  function onReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }

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
    if (w.freeShippingBars) {
      w.freeShippingBars.forEach(function (bar) {
        renderFreeShippingBar(bar, page, currencySymbol);
      });
      setupCartChangeListener(w.freeShippingBars, page, currencySymbol);
    }
    if (w.stickyCarts)
      w.stickyCarts.forEach(function (cart) {
        renderStickyCart(cart, currencySymbol);
      });
    if (w.countdownTimers)
      w.countdownTimers.forEach(function (timer) {
        renderCountdownTimer(timer, page, gs);
      });
  }

  function detectPage() {
    var path = window.location.pathname;
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
  function _parseProductJson(data) {
    var p = data.product || {};
    var v = (p.variants && p.variants[0]) || {};
    return {
      id: p.id,
      handle: p.handle,
      price: parseFloat(v.price) || 0,
      compare_at_price: parseFloat(v.compare_at_price) || 0,
      inventory_quantity: v.inventory_quantity,
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
      inventory_quantity: v.inventory_quantity,
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
      } else {
        // Excluded-collection list still loading — withhold the badge until we
        // know for sure, so we don't briefly flash on products that should be
        // hidden. A retry pass after the prefetch lands will pick it up.
        return false;
      }
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

  // Main product badges orchestrator — handles multi-badge, conditions, scheduling, pages
  function renderProductBadges(badges, currentPage) {
    // Filter badges by page and schedule first
    var eligible = badges.filter(function (b) {
      return badgeShowOnPage(b, currentPage) && badgeInSchedule(b);
    });
    if (eligible.length === 0) return;

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
      });
    });

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

  // Listen for cart mutations and refresh all free shipping bars live
  function setupCartChangeListener(bars, page, currencySymbol) {
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
        ".cart-drawer__footer .price", ".cart__footer .price"
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

    var atcBtn = document.querySelector(ATC_SELECTORS);
    if (!atcBtn) return;

    var textColor   = cart.textColor   || "#ffffff";
    var buttonColor = cart.buttonColor || "#ffffff";
    var bgColor     = cart.bgColor     || "#000000";
    var radius      = cart.buttonRadius || "6";
    var isOutline   = cart.buttonStyle === "outline";
    var btnBg       = isOutline ? "transparent" : buttonColor;
    var btnColor    = isOutline ? buttonColor : bgColor;
    var btnBorder   = isOutline ? "2px solid " + buttonColor : "none";

    var el = document.createElement("div");
    el.id = "badgehq-sticky-cart";
    el.style.cssText =
      "position:fixed;left:0;right:0;z-index:9998;display:none;" +
      (cart.position === "top" ? "top:0;" : "bottom:0;") +
      "background:" + bgColor + ";padding:10px 16px;" +
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

      if (freshBtn && !freshBtn.disabled) {
        freshBtn.click();
      } else {
        // Last resort: submit the form directly
        var form = document.querySelector('form[action*="/cart/add"]');
        if (form) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
    };

    document.body.appendChild(el);

    if (cart.alwaysShow) {
      el.style.display = "block";
    } else {
      var observer = new IntersectionObserver(
        function (entries) {
          el.style.display = entries[0].isIntersecting ? "none" : "block";
        },
        { threshold: 0 }
      );
      observer.observe(atcBtn);
    }
  }

  /* ===================== COUNTDOWN TIMER ===================== */
  function renderCountdownTimer(timer, page, gs) {
    if (!shouldShowOnPage(timer.pages, page)) return;

    var endDate = new Date(timer.endDate);
    if (endDate <= new Date()) return;

    var c = timer.colors || {};
    var m = timer.messages || {};

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
    setInterval(update, 1000);

    var target = document.querySelector(
      'form[action*="/cart/add"], .product-form, main, #MainContent'
    );
    if (target)
      target.parentNode.insertBefore(el, target.nextSibling);
  }
})();
