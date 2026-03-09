/**
 * BadgeHQ - Storefront Widget Script
 * Vanilla JS, no dependencies. Injected into store themes.
 * Fetches config from app proxy and renders all active widgets.
 */
(function () {
  "use strict";

  var SHOP = window.Shopify && window.Shopify.shop;
  if (!SHOP) return;

  var API_URL = "/apps/badgehq/api/widgets?shop=" + encodeURIComponent(SHOP);

  fetch(API_URL)
    .then(function (r) {
      return r.json();
    })
    .then(function (data) {
      if (!data.enabled) return;
      window.__BADGEHQ__ = data;
      initBadgeHQ(data);
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
    if (w.productBadges)
      w.productBadges.forEach(function (badge) {
        renderProductBadge(badge);
      });
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
    if (path === "/" || path === "") return "home";
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
  function renderTrustBadge(badge, page, gs) {
    if (!shouldShowOnPage(badge.pages, page)) return;
    if (page !== "product") return;

    var s = badge.settings || {};
    var sizeMap = { small: 32, medium: 44, large: 56 };
    var iconSize = sizeMap[s.size] || 44;
    var fontMap = { small: 8, medium: 10, large: 12 };
    var fontSize = fontMap[s.size] || 10;

    var labels = {
      paypal: "PayPal",
      visa: "Visa",
      mastercard: "MC",
      amex: "Amex",
      "apple-pay": "Apple Pay",
      "google-pay": "G Pay",
      stripe: "Stripe",
      "ssl-secure": "SSL",
      "money-back": "Money Back",
      "free-shipping": "Free Ship",
      "support-24-7": "24/7",
      "easy-returns": "Returns",
    };

    var container = document.createElement("div");
    container.id = "badgehq-trust-" + badge.id;
    container.style.cssText =
      "background:" +
      (s.bgColor || "#fff") +
      ";padding:16px;border-radius:8px;text-align:center;margin:12px 0;font-family:" +
      (gs.fontFamily || "inherit") +
      ";";

    if (s.showTitle !== false) {
      var title = document.createElement("p");
      title.textContent = badge.title;
      title.style.cssText =
        "margin:0 0 12px;font-weight:600;font-size:" + (fontSize + 4) + "px;";
      container.appendChild(title);
    }

    var wrap = document.createElement("div");
    wrap.style.cssText =
      "display:flex;flex-wrap:wrap;gap:8px;justify-content:center;";

    (badge.badges || []).forEach(function (iconId) {
      var d = document.createElement("div");
      d.style.cssText =
        "width:" +
        iconSize +
        "px;height:" +
        iconSize +
        "px;display:flex;align-items:center;justify-content:center;background:" +
        (s.badgeColor || "#333") +
        ";color:#fff;border-radius:6px;font-size:" +
        fontSize +
        "px;font-weight:600;text-align:center;line-height:1.2;padding:2px;";
      d.textContent = labels[iconId] || iconId;
      wrap.appendChild(d);
    });

    container.appendChild(wrap);

    var target =
      badge.position === "before-add-to-cart"
        ? document.querySelector(
            'form[action*="/cart/add"] button[type="submit"], .product-form__submit, [name="add"]'
          )
        : document.querySelector(
            'form[action*="/cart/add"], .product-form'
          );

    if (target) {
      if (badge.position === "before-add-to-cart") {
        target.parentNode.insertBefore(container, target);
      } else {
        target.parentNode.insertBefore(container, target.nextSibling);
      }
    }
  }

  /* ===================== PRODUCT BADGES ===================== */
  function renderProductBadge(badge) {
    var images = document.querySelectorAll(
      ".product-card img, .product__media img, .grid-product__image, .product-image-container img"
    );
    if (images.length === 0)
      images = document.querySelectorAll('[class*="product"] img');

    images.forEach(function (img) {
      var parent = img.closest("a") || img.parentElement;
      if (!parent || parent.querySelector(".badgehq-product-badge")) return;
      parent.style.position = "relative";
      parent.style.overflow = "hidden";

      var el = document.createElement("div");
      el.className = "badgehq-product-badge";

      var posStyles = {
        "top-left": "top:8px;left:8px;",
        "top-right": "top:8px;right:8px;",
        "bottom-left": "bottom:8px;left:8px;",
        "bottom-right": "bottom:8px;right:8px;",
      };
      var shapeStyles = {
        circle: "border-radius:50%;width:48px;height:48px;",
        rectangle: "border-radius:4px;padding:4px 10px;",
        ribbon: "border-radius:0 4px 4px 0;padding:4px 12px 4px 8px;",
        star: "border-radius:4px;width:48px;height:48px;clip-path:polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%);",
        square: "border-radius:2px;width:48px;height:48px;",
      };

      el.style.cssText =
        "position:absolute;z-index:10;display:flex;align-items:center;justify-content:center;" +
        "background:" +
        badge.badgeColor +
        ";color:" +
        badge.textColor +
        ";font-size:11px;font-weight:700;" +
        (posStyles[badge.position] || posStyles["top-left"]) +
        (shapeStyles[badge.shape] || shapeStyles["rectangle"]);

      el.textContent = badge.text;
      parent.appendChild(el);
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
