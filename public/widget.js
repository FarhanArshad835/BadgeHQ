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
    if (w.freeShippingBars)
      w.freeShippingBars.forEach(function (bar) {
        renderFreeShippingBar(bar, page);
      });
    if (w.stickyCarts)
      w.stickyCarts.forEach(function (cart) {
        renderStickyCart(cart);
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
  var POS_STYLES = {
    "top-left": "top:8px;left:8px;",
    "top-right": "top:8px;right:8px;",
    "bottom-left": "bottom:8px;left:8px;",
    "bottom-right": "bottom:8px;right:8px;",
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

  // Check targeting against product metadata embedded in DOM
  function badgeTargetMatch(badge, productEl) {
    var t = badge.targeting;
    if (!t || t.type === "all") return true;

    // Try to extract product metadata from the DOM or Shopify globals
    var productMeta = getProductMeta(productEl);
    if (!productMeta) return true; // can't verify, show by default

    switch (t.type) {
      case "tag":
        return productMeta.tags && productMeta.tags.indexOf(t.value) !== -1;
      case "product_type":
        return productMeta.type && productMeta.type.toLowerCase() === (t.value || "").toLowerCase();
      case "vendor":
        return productMeta.vendor && productMeta.vendor.toLowerCase() === (t.value || "").toLowerCase();
      case "collection":
        return productMeta.collections && productMeta.collections.indexOf(t.value) !== -1;
      case "products":
        var ids = (t.value || "").split(",").map(function (s) { return s.trim(); });
        return productMeta.id && ids.indexOf(String(productMeta.id)) !== -1;
      default:
        return true;
    }
  }

  // Extract product metadata from DOM context or Shopify global
  function getProductMeta(el) {
    // On product pages, use the global product JSON
    if (window.__BADGEHQ_PRODUCT__) return window.__BADGEHQ_PRODUCT__;

    // Try to find product JSON-LD
    if (!window.__BADGEHQ_PRODUCT__ && window.ShopifyAnalytics && window.ShopifyAnalytics.meta && window.ShopifyAnalytics.meta.product) {
      var m = window.ShopifyAnalytics.meta.product;
      window.__BADGEHQ_PRODUCT__ = {
        id: m.id, tags: [], type: m.type || "", vendor: m.vendor || "",
        collections: [], price: 0, compare_at_price: 0, inventory_quantity: undefined,
        created_at: null,
      };
      return window.__BADGEHQ_PRODUCT__;
    }

    // On collection / home pages, try to read data attributes from the card
    if (el) {
      var card = el.closest("[data-product-id]");
      if (card) {
        return {
          id: card.getAttribute("data-product-id"),
          tags: (card.getAttribute("data-tags") || "").split(","),
          type: card.getAttribute("data-product-type") || "",
          vendor: card.getAttribute("data-vendor") || "",
          collections: (card.getAttribute("data-collections") || "").split(","),
        };
      }
    }

    return null;
  }

  // Fetch product JSON for condition evaluation (product pages only)
  function fetchProductData(callback) {
    if (window.__BADGEHQ_PRODUCT_DATA__) {
      callback(window.__BADGEHQ_PRODUCT_DATA__);
      return;
    }
    var path = window.location.pathname;
    if (!path.match(/\/products\//)) { callback(null); return; }

    fetch(path + ".json")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var p = data.product || {};
        var v = (p.variants && p.variants[0]) || {};
        window.__BADGEHQ_PRODUCT_DATA__ = {
          id: p.id, price: parseFloat(v.price) || 0,
          compare_at_price: parseFloat(v.compare_at_price) || 0,
          inventory_quantity: v.inventory_quantity,
          created_at: p.created_at, tags: (p.tags || "").split(", "),
          type: p.product_type || "", vendor: p.vendor || "",
          sold: 0, // Shopify doesn't expose this directly
        };
        callback(window.__BADGEHQ_PRODUCT_DATA__);
      })
      .catch(function () { callback(null); });
  }

  // Main product badges orchestrator — handles multi-badge, conditions, scheduling, pages
  function renderProductBadges(badges, currentPage) {
    // Filter badges by page and schedule first
    var eligible = badges.filter(function (b) {
      return badgeShowOnPage(b, currentPage) && badgeInSchedule(b);
    });
    if (eligible.length === 0) return;

    // Fetch product data for condition evaluation, then render
    fetchProductData(function (productData) {

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

        // Skip placeholder GIFs / images that haven't decoded yet
        if (!img.complete || img.naturalWidth <= 1) return;

        eligible.forEach(function (badge) {
          var key = "data-badgehq-" + badge.id;

          // Track on the image element itself (survives parent DOM changes)
          if (img.getAttribute(key)) return;
          img.setAttribute(key, "1");

          // Check targeting
          if (!badgeTargetMatch(badge, img)) return;

          // Check automated condition
          if (!badgeConditionMet(badge, productData)) return;

          // Walk up the DOM to find the nearest already-positioned ancestor.
          // NEVER modify existing element CSS — setting position:relative on a
          // static ancestor resets Dawn's padding-bottom aspect-ratio layout,
          // making images collapse to height:0 (the "images disappear" bug).
          var container = null;
          var node = img.parentElement;
          for (var i = 0; i < 8; i++) {
            if (!node || node === document.body) break;
            if (node.tagName === "PICTURE") { node = node.parentElement; continue; }
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

          // Render image badge
          if (badge.badgeType === "image" && badge.imageUrl) {
            var imgEl = document.createElement("img");
            imgEl.className = "badgehq-product-badge badgehq-pb-" + badge.id;
            imgEl.src = badge.imageUrl;
            imgEl.alt = badge.text || "Badge";
            imgEl.style.cssText =
              "position:absolute;z-index:10;max-width:80px;height:auto;pointer-events:none;" +
              "opacity:" + (badge.opacity || 1) + ";" +
              (badge.rotation ? "transform:rotate(" + badge.rotation + "deg);" : "") +
              (POS_STYLES[badge.position] || POS_STYLES["top-left"]) +
              (badge.customCSS || "");
            container.appendChild(imgEl);
            return;
          }

          // Render text / dynamic badge
          var el = document.createElement("div");
          el.className = "badgehq-product-badge badgehq-pb-" + badge.id;

          var bgStyle = badge.gradient
            ? "background:" + badge.gradient + ";"
            : "background:" + badge.badgeColor + ";";

          el.style.cssText =
            "position:absolute;z-index:10;display:flex;align-items:center;justify-content:center;" +
            bgStyle +
            "color:" + badge.textColor + ";" +
            "font-size:" + (badge.fontSize || 11) + "px;font-weight:700;line-height:1;" +
            "width:auto;height:auto;max-width:max-content;white-space:nowrap;box-sizing:border-box;pointer-events:none;" +
            "opacity:" + (badge.opacity || 1) + ";" +
            (badge.rotation ? "transform:rotate(" + badge.rotation + "deg);" : "") +
            (badge.borderWidth ? "border:" + badge.borderWidth + "px solid " + (badge.borderColor || "#000") + ";" : "") +
            (POS_STYLES[badge.position] || POS_STYLES["top-left"]) +
            (SHAPE_STYLES[badge.shape] || SHAPE_STYLES["rectangle"]) +
            (badge.customCSS || "");

          el.textContent = badge.badgeType === "dynamic"
            ? resolveDynamicText(badge.text, productData)
            : badge.text;

          container.appendChild(el);
        });
      }

      function findAndAttach() {
        document.querySelectorAll(SELECTORS).forEach(attachBadges);
      }

      // Delay first run so theme JS (lazy-loaders, image reveal animations) finishes
      // before we touch the DOM. Retries catch images loaded later (lazy scroll, AJAX).
      setTimeout(findAndAttach, 1000);
      setTimeout(findAndAttach, 2500);
      setTimeout(findAndAttach, 6000);
    });
  }

  /* ===================== FREE SHIPPING BAR ===================== */
  function renderFreeShippingBar(bar, page) {
    if (!shouldShowOnPage(bar.pages, page)) return;

    fetch("/cart.js")
      .then(function (r) {
        return r.json();
      })
      .then(function (cart) {
        render(cart.total_price / 100);
      })
      .catch(function () {
        render(0);
      });

    function render(total) {
      var c = bar.colors || {};
      var m = bar.messages || {};
      var pct = Math.min((total / bar.threshold) * 100, 100);
      var remaining = Math.max(bar.threshold - total, 0).toFixed(2);
      var msg =
        pct >= 100
          ? m.reached || "Free shipping!"
          : (m.below || "").replace("{{amount}}", "$" + remaining);

      var el = document.createElement("div");
      el.id = "badgehq-freeship-" + bar.id;
      el.style.cssText = "padding:12px 16px;text-align:center;margin:8px 0;";

      el.innerHTML =
        '<p style="color:' +
        (c.text || "#333") +
        ';margin:0 0 8px;font-size:14px;">' +
        msg +
        "</p>" +
        '<div style="background:' +
        (c.barBg || "#f0f0f0") +
        ';border-radius:10px;height:20px;overflow:hidden;">' +
        '<div style="background:' +
        (c.progressBg || "#4caf50") +
        ";height:100%;width:" +
        pct +
        '%;border-radius:10px;transition:width 0.3s;"></div></div>';

      var target = document.querySelector(
        ".cart__footer, .cart-footer, [class*='cart'] form"
      );
      if (target) target.parentNode.insertBefore(el, target);
      else {
        var main = document.querySelector(
          "main, #MainContent, .main-content"
        );
        if (main) main.prepend(el);
      }
    }
  }

  /* ===================== STICKY ADD TO CART ===================== */
  function renderStickyCart(cart) {
    if (!cart.showMobile && window.innerWidth < 768) return;
    if (!cart.showDesktop && window.innerWidth >= 768) return;

    var atcBtn = document.querySelector(
      'form[action*="/cart/add"] button[type="submit"], .product-form__submit, [name="add"]'
    );
    if (!atcBtn) return;

    var el = document.createElement("div");
    el.id = "badgehq-sticky-cart";
    el.style.cssText =
      "position:fixed;left:0;right:0;z-index:9998;display:none;" +
      (cart.position === "top" ? "top:0;" : "bottom:0;") +
      "background:" +
      cart.bgColor +
      ";padding:10px 16px;" +
      "box-shadow:0 " +
      (cart.position === "top" ? "2px" : "-2px") +
      " 8px rgba(0,0,0,0.15);";

    el.innerHTML =
      '<div style="max-width:1200px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px;">' +
      "<div>" +
      '<div style="color:' +
      cart.buttonColor +
      ';font-size:14px;font-weight:600;" id="badgehq-sticky-title">Product</div>' +
      "</div>" +
      '<button style="background:' +
      cart.buttonColor +
      ";color:" +
      cart.bgColor +
      ';border:none;padding:10px 24px;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;">' +
      cart.buttonText +
      "</button></div>";

    // Try to get the product title
    var productTitle = document.querySelector(
      ".product__title, .product-single__title, h1"
    );
    if (productTitle) {
      var titleEl = el.querySelector("#badgehq-sticky-title");
      if (titleEl) titleEl.textContent = productTitle.textContent.trim();
    }

    el.querySelector("button").onclick = function () {
      atcBtn.click();
    };

    document.body.appendChild(el);

    var observer = new IntersectionObserver(
      function (entries) {
        el.style.display = entries[0].isIntersecting ? "none" : "block";
      },
      { threshold: 0 }
    );
    observer.observe(atcBtn);
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
