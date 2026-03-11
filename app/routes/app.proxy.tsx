import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (!shop) {
    return new Response("Missing shop parameter", { status: 400 });
  }

  const appSettings = await prisma.appSettings.findUnique({
    where: { shop },
  });

  if (appSettings && !appSettings.isEnabled) {
    return new Response("/* BadgeHQ disabled */", {
      headers: {
        "Content-Type": "application/javascript",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  }

  const script = `
(function() {
  'use strict';

  var BADGEHQ_SHOP = '${shop.replace(/'/g, "\\'")}';
  var BADGEHQ_API = window.location.origin + '/apps/badgehq/api/widgets?shop=' + encodeURIComponent(BADGEHQ_SHOP);

  // Load widget config from API
  fetch(BADGEHQ_API)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.enabled) return;
      window.__BADGEHQ__ = data;
      initBadgeHQ(data);
    })
    .catch(function(e) { console.warn('BadgeHQ: Failed to load config', e); });

  function initBadgeHQ(data) {
    var gs = data.globalSettings || {};
    var w = data.widgets || {};
    var page = detectPage();

    if (w.announcementBars) w.announcementBars.forEach(function(bar) { renderAnnouncementBar(bar, page); });
    if (w.trustBadges) w.trustBadges.forEach(function(badge) { renderTrustBadge(badge, page, gs); });
    if (w.productBadges) w.productBadges.forEach(function(badge) { renderProductBadge(badge, page); });
    if (w.freeShippingBars) w.freeShippingBars.forEach(function(bar) { renderFreeShippingBar(bar, page); });
    if (w.stickyCarts) w.stickyCarts.forEach(function(cart) { renderStickyCart(cart); });
    if (w.countdownTimers) w.countdownTimers.forEach(function(timer) { renderCountdownTimer(timer, page, gs); });
  }

  function detectPage() {
    var path = window.location.pathname;
    if (path.match(/\\/products\\//)) return 'product';
    if (path.match(/\\/cart/)) return 'cart';
    if (path.match(/\\/collections\\//)) return 'collection';
    // Match homepage: exactly "/" or Shopify Markets locale prefixes like /en, /fr, /en-US
    if (path === '/' || path === '' || /^\\/[a-z]{2}(-[a-z]{2,4})?\\/?\$/i.test(path)) return 'home';
    return 'other';
  }

  function shouldShowOnPage(pages, currentPage) {
    if (!pages || pages.length === 0) return true;
    if (pages.indexOf('all') !== -1) return true;
    return pages.indexOf(currentPage) !== -1;
  }

  // ANNOUNCEMENT BAR
  function renderAnnouncementBar(bar, page) {
    if (!shouldShowOnPage(bar.pages, page)) return;
    if (bar.schedule) {
      var now = new Date();
      if (bar.schedule.startDate && new Date(bar.schedule.startDate) > now) return;
      if (bar.schedule.endDate && new Date(bar.schedule.endDate) < now) return;
    }

    var el = document.createElement('div');
    el.id = 'badgehq-announcement-' + bar.id;
    el.style.cssText = 'background:' + bar.bgColor + ';color:' + bar.textColor +
      ';padding:10px 40px;text-align:center;font-size:14px;position:relative;z-index:9999;';

    var msgs = bar.messages || [];
    var idx = 0;
    var textEl = document.createElement('span');
    function showMsg() {
      if (msgs.length === 0) return;
      var m = msgs[idx % msgs.length];
      textEl.textContent = (m.emoji ? m.emoji + ' ' : '') + m.text;
    }
    showMsg();
    el.appendChild(textEl);

    if (msgs.length > 1) {
      setInterval(function() { idx++; showMsg(); }, 4000);
    }

    if (bar.showClose) {
      var closeBtn = document.createElement('span');
      closeBtn.textContent = '\\u00D7';
      closeBtn.style.cssText = 'position:absolute;right:12px;top:50%;transform:translateY(-50%);cursor:pointer;font-size:18px;opacity:0.7;';
      closeBtn.onclick = function() { el.remove(); };
      el.appendChild(closeBtn);
    }

    document.body.insertBefore(el, document.body.firstChild);
  }

  // TRUST BADGES
  function renderTrustBadge(badge, page, gs) {
    if (!shouldShowOnPage(badge.pages, page)) return;
    if (page !== 'product') return;

    var s = badge.settings || {};
    var sizeMap = { small: 32, medium: 44, large: 56 };
    var iconSize = sizeMap[s.size] || 44;
    var fontMap = { small: 8, medium: 10, large: 12 };
    var fontSize = fontMap[s.size] || 10;

    var container = document.createElement('div');
    container.id = 'badgehq-trust-' + badge.id;
    container.style.cssText = 'background:' + (s.bgColor || '#fff') +
      ';padding:16px;border-radius:8px;text-align:center;margin:12px 0;font-family:' + (gs.fontFamily || 'inherit') + ';';

    if (s.showTitle !== false) {
      var title = document.createElement('p');
      title.textContent = badge.title;
      title.style.cssText = 'margin:0 0 12px;font-weight:600;font-size:' + (fontSize + 4) + 'px;';
      container.appendChild(title);
    }

    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;justify-content:center;';

    var icons = badge.badges || [];
    icons.forEach(function(iconId) {
      var d = document.createElement('div');
      d.style.cssText = 'width:' + iconSize + 'px;height:' + iconSize +
        'px;display:flex;align-items:center;justify-content:center;background:' +
        (s.badgeColor || '#333') + ';color:#fff;border-radius:6px;font-size:' +
        fontSize + 'px;font-weight:600;text-align:center;line-height:1.2;padding:2px;';
      var labels = {
        'paypal':'PayPal','visa':'Visa','mastercard':'MC','amex':'Amex',
        'apple-pay':'Apple Pay','google-pay':'G Pay','stripe':'Stripe',
        'ssl-secure':'SSL','money-back':'Money Back','free-shipping':'Free Ship',
        'support-24-7':'24/7','easy-returns':'Returns'
      };
      d.textContent = labels[iconId] || iconId;
      wrap.appendChild(d);
    });

    container.appendChild(wrap);

    var target = badge.position === 'before-add-to-cart'
      ? document.querySelector('form[action*="/cart/add"] button[type="submit"], .product-form__submit, [name="add"]')
      : document.querySelector('form[action*="/cart/add"], .product-form');

    if (target) {
      if (badge.position === 'before-add-to-cart') {
        target.parentNode.insertBefore(container, target);
      } else {
        target.parentNode.insertBefore(container, target.nextSibling);
      }
    }
  }

  // PRODUCT BADGES
  function renderProductBadge(badge, page) {
    if (!shouldShowOnPage(badge.pages, page)) return;

    var posStyles = {
      'top-left': 'top:8px;left:8px;',
      'top-right': 'top:8px;right:8px;',
      'bottom-left': 'bottom:8px;left:8px;',
      'bottom-right': 'bottom:8px;right:8px;',
    };
    var shapeStyles = {
      'circle': 'border-radius:50%;width:48px;height:48px;',
      'rectangle': 'border-radius:4px;padding:4px 10px;',
      'ribbon': 'border-radius:0 4px 4px 0;padding:4px 12px 4px 8px;',
      'star': 'border-radius:4px;width:48px;height:48px;clip-path:polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%);',
      'square': 'border-radius:2px;width:48px;height:48px;',
    };
    var badgeClass = 'badgehq-pb-' + badge.id;

    function attachBadge(img) {
      // naturalWidth > 1 means the real image has decoded (not a 1×1 placeholder GIF).
      // getBoundingClientRect width is non-zero even for unloaded lazy images that have
      // CSS width:100%, so we must use naturalWidth instead.
      if (!img.complete || img.naturalWidth <= 1) return;

      // Track on the image itself — survives parent DOM changes during lazy loading
      if (img.getAttribute('data-badgehq') === String(badge.id)) return;
      img.setAttribute('data-badgehq', String(badge.id));

      // Walk up the DOM to find the nearest ancestor that is ALREADY positioned.
      // Every Shopify theme sets position:relative on product card image containers
      // (needed for their own Sale/Sold Out badges), so this almost always succeeds.
      // Crucially, we NEVER modify any existing element's CSS — that was causing
      // the theme's image reveal animations/transitions to reset and hide images.
      var container = null;
      var node = img.parentElement;
      for (var i = 0; i < 8; i++) {
        if (!node || node === document.body) break;
        if (node.tagName === 'PICTURE') { node = node.parentElement; continue; }
        if (window.getComputedStyle(node).position !== 'static') { container = node; break; }
        node = node.parentElement;
      }

      // Fallback for unusual themes: use direct block parent and set position only then
      if (!container) {
        node = img.parentElement;
        while (node && node !== document.body && (
          node.tagName === 'PICTURE' ||
          window.getComputedStyle(node).display === 'inline'
        )) { node = node.parentElement; }
        if (!node || node === document.body) return;
        container = node;
        container.style.position = 'relative';
      }

      var el = document.createElement('div');
      el.className = 'badgehq-product-badge ' + badgeClass;
      el.style.cssText = 'position:absolute;z-index:10;display:flex;align-items:center;justify-content:center;pointer-events:none;' +
        'background:' + badge.badgeColor + ';color:' + badge.textColor + ';font-size:11px;font-weight:700;' +
        (posStyles[badge.position] || posStyles['top-left']) +
        (shapeStyles[badge.shape] || shapeStyles['rectangle']);
      el.textContent = badge.text;
      container.appendChild(el);
    }

    function findAndAttach() {
      var selectors = [
        '.product-card img',
        '.product-card-wrapper img',
        '.card__media img',
        '.card-product__image img',
        '.product__media img',
        '.product-media-container img',
        '.grid-product__image',
        '.product-image-container img',
        '.product-item__image img',
        '.product-grid-item img',
        '[class*="product-card"] img',
        '[class*="ProductCard"] img',
        '[class*="product-image"] img',
        'a[href*="/products/"] img',
      ].join(',');
      document.querySelectorAll(selectors).forEach(attachBadge);
    }

    // Start at 1s so the theme's lazy-load + image reveal animations finish first.
    // Retries at 2.5s and 6s catch images loaded further down the page.
    setTimeout(findAndAttach, 1000);
    setTimeout(findAndAttach, 2500);
    setTimeout(findAndAttach, 6000);
  }

  // FREE SHIPPING BAR
  function renderFreeShippingBar(bar, page) {
    if (!shouldShowOnPage(bar.pages, page)) return;

    var cartTotal = 0;
    try {
      fetch('/cart.js').then(function(r) { return r.json(); }).then(function(cart) {
        cartTotal = cart.total_price / 100;
        render(cartTotal);
      });
    } catch(e) { render(0); }

    function render(total) {
      var c = bar.colors || {};
      var m = bar.messages || {};
      var pct = Math.min((total / bar.threshold) * 100, 100);
      var remaining = Math.max(bar.threshold - total, 0).toFixed(2);
      var msg = pct >= 100
        ? (m.reached || 'Free shipping!')
        : (m.below || '').replace('{{amount}}', '$' + remaining);

      var el = document.createElement('div');
      el.id = 'badgehq-freeship-' + bar.id;
      el.style.cssText = 'padding:12px 16px;text-align:center;margin:8px 0;';

      el.innerHTML = '<p style="color:' + (c.text || '#333') + ';margin:0 0 8px;font-size:14px;">' + msg + '</p>' +
        '<div style="background:' + (c.barBg || '#f0f0f0') + ';border-radius:10px;height:20px;overflow:hidden;">' +
        '<div style="background:' + (c.progressBg || '#4caf50') + ';height:100%;width:' + pct + '%;border-radius:10px;transition:width 0.3s;"></div></div>';

      var target = document.querySelector('.cart__footer, .cart-footer, [class*="cart"] form');
      if (target) target.parentNode.insertBefore(el, target);
      else document.querySelector('main, #MainContent, .main-content')?.prepend(el);
    }
  }

  // STICKY ADD TO CART
  function renderStickyCart(cart) {
    if (!cart.showMobile && window.innerWidth < 768) return;
    if (!cart.showDesktop && window.innerWidth >= 768) return;

    var atcBtn = document.querySelector('form[action*="/cart/add"] button[type="submit"], .product-form__submit, [name="add"]');
    if (!atcBtn) return;

    var el = document.createElement('div');
    el.id = 'badgehq-sticky-cart';
    el.style.cssText = 'position:fixed;left:0;right:0;z-index:9998;display:none;' +
      (cart.position === 'top' ? 'top:0;' : 'bottom:0;') +
      'background:' + cart.bgColor + ';padding:10px 16px;' +
      'box-shadow:0 ' + (cart.position === 'top' ? '2px' : '-2px') + ' 8px rgba(0,0,0,0.15);';

    el.innerHTML = '<div style="max-width:1200px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px;">' +
      '<div><div style="color:' + cart.buttonColor + ';font-size:14px;font-weight:600;">Product</div></div>' +
      '<button style="background:' + cart.buttonColor + ';color:' + cart.bgColor + ';border:none;padding:10px 24px;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;">' +
      cart.buttonText + '</button></div>';

    el.querySelector('button').onclick = function() { atcBtn.click(); };

    document.body.appendChild(el);

    var observer = new IntersectionObserver(function(entries) {
      el.style.display = entries[0].isIntersecting ? 'none' : 'block';
    }, { threshold: 0 });
    observer.observe(atcBtn);
  }

  // COUNTDOWN TIMER
  function renderCountdownTimer(timer, page, gs) {
    if (!shouldShowOnPage(timer.pages, page)) return;

    var endDate = new Date(timer.endDate);
    if (endDate <= new Date()) return;

    var c = timer.colors || {};
    var m = timer.messages || {};

    var el = document.createElement('div');
    el.id = 'badgehq-countdown-' + timer.id;
    el.style.cssText = 'background:' + (c.bg || '#000') + ';color:' + (c.text || '#fff') +
      ';padding:16px;text-align:center;margin:12px 0;border-radius:8px;font-family:' + (gs.fontFamily || 'inherit') + ';';

    function update() {
      var now = new Date();
      var diff = endDate - now;
      if (diff <= 0) { el.remove(); return; }

      var days = Math.floor(diff / 86400000);
      var hours = Math.floor((diff % 86400000) / 3600000);
      var mins = Math.floor((diff % 3600000) / 60000);
      var secs = Math.floor((diff % 60000) / 1000);

      var parts = timer.style === 'compact'
        ? [['Hours', String(days * 24 + hours).padStart(2,'0')],['Min', String(mins).padStart(2,'0')],['Sec', String(secs).padStart(2,'0')]]
        : [['Days', String(days).padStart(2,'0')],['Hours', String(hours).padStart(2,'0')],['Min', String(mins).padStart(2,'0')],['Sec', String(secs).padStart(2,'0')]];

      el.innerHTML = '<p style="margin:0 0 12px;font-size:14px;">' + (m.above || '') + '</p>' +
        '<div style="display:flex;justify-content:center;gap:8px;">' +
        parts.map(function(p) {
          return '<div style="text-align:center;"><div style="background:' + (c.accent || '#e74c3c') +
            ';color:' + (c.text || '#fff') + ';padding:8px 12px;border-radius:6px;font-size:20px;font-weight:700;min-width:48px;">' +
            p[1] + '</div><div style="font-size:10px;margin-top:4px;opacity:0.7;">' + p[0] + '</div></div>';
        }).join('') + '</div>' +
        '<p style="margin:12px 0 0;font-size:12px;opacity:0.8;">' + (m.below || '') + '</p>';
    }

    update();
    setInterval(update, 1000);

    var target = document.querySelector('form[action*="/cart/add"], .product-form, main, #MainContent');
    if (target) target.parentNode.insertBefore(el, target.nextSibling);
  }
})();
`;

  return new Response(script, {
    headers: {
      "Content-Type": "application/javascript",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
};
