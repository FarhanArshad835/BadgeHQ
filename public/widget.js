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
  function wlToggle(handle) {
    if (!handle) return;
    var list = wlGet();
    var i = list.indexOf(handle);
    if (i === -1) list.push(handle); else list.splice(i, 1);
    wlSave(list);
    wlScheduleSync();
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
        // Outline in the ATC's fill color so the pair reads as primary/secondary.
        var atcBg = abs.backgroundColor;
        if (atcBg && atcBg !== "rgba(0, 0, 0, 0)" && atcBg !== "transparent") {
          btn.style.borderColor = atcBg;
          btn.style.color = atcBg;
        }
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
      ".badgehq-bis__panel{display:none;margin-top:10px;padding:14px;border:1px solid rgba(0,0,0,0.12);" +
      "border-radius:var(--buttons-radius,6px);}" +
      ".badgehq-bis__panel.is-open{display:block;}" +
      ".badgehq-bis__heading{font-weight:600;margin:0 0 8px;}" +
      ".badgehq-bis__row{display:flex;gap:8px;align-items:stretch;}" +
      ".badgehq-bis__input{flex:1 1 auto;min-width:0;padding:10px 12px;font:inherit;box-sizing:border-box;" +
      "color:rgb(var(--color-foreground,18 18 18));background:rgb(var(--color-background,255 255 255));" +
      "border:1px solid rgba(var(--color-foreground,18 18 18),0.25);border-radius:var(--inputs-radius,4px);}" +
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
      var bg = abs.backgroundColor;
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
        btn.style.borderColor = bg;
        btn.style.color = bg;
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
        '<input class="badgehq-bis__input" type="email" inputmode="email" autocomplete="email" ' +
        'placeholder="you@example.com" aria-label="' + escapeDeHtml(cfg.headingText) + '" data-bis-email>' +
        '<button type="button" class="badgehq-bis__submit" data-bis-submit>Notify me</button>' +
        "</div>" +
        '<p class="badgehq-bis__note">' + escapeDeHtml(cfg.consentText) + "</p>" +
        '<div class="badgehq-bis__msg" data-bis-msg aria-live="polite"></div>' +
        "</div>";
    }

    // Placement.
    if (cfg.placement === "replace-button" && atc) {
      atc.style.display = "none";
      bisHiddenBtn = atc;
      if (atc.parentNode) atc.parentNode.insertBefore(wrap, atc.nextSibling);
      else anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
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
        var input = wrap.querySelector("[data-bis-email]");
        if (panel.classList.contains("is-open") && input) input.focus();
      });
    }

    var submit = wrap.querySelector("[data-bis-submit]");
    if (submit) {
      submit.addEventListener("click", function () {
        bisSubmit(wrap, cfg, variantId, productId);
      });
      var emailInput = wrap.querySelector("[data-bis-email]");
      emailInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          bisSubmit(wrap, cfg, variantId, productId);
        }
      });
    }
  }

  function bisSubmit(wrap, cfg, variantId, productId) {
    var input = wrap.querySelector("[data-bis-email]");
    var submit = wrap.querySelector("[data-bis-submit]");
    var msg = wrap.querySelector("[data-bis-msg]");
    var email = (input.value || "").trim();

    function setMsg(kind, text) {
      msg.className = "badgehq-bis__msg" + (kind ? " badgehq-bis__msg--" + kind : "");
      msg.textContent = text;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      setMsg("err", "Please enter a valid email address.");
      input.focus();
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
        email: email,
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
})();
