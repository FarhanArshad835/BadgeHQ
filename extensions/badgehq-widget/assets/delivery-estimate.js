/*
  BadgeHQ: PIN-code delivery-estimate widget (Delhivery).

  Talks to the BadgeHQ Cloudflare Worker at the endpoint given by the block's
  data-de-endpoint attribute, passing ?shop=&pincode=. The worker edge-caches
  and proxies to the BadgeHQ backend, which holds the merchant's Delhivery
  token — the token is NEVER in this file or the browser.

  Expected JSON response:
    { "serviceable": true,  "etaDate": "2026-07-22", "etaText": "Tue, 22 Jul",
      "modes": [{ "mode": "standard", "serviceable": true, "etaDate": "...", "etaText": "..." },
                { "mode": "express", ... }] }
    { "serviceable": false, "modes": [...] }
  ("modes" follows the merchant's delivery-speed setting; older cached
  responses without it fall back to the top-level etaDate/etaText.)
  404 means the merchant hasn't configured/enabled the feature yet — the
  widget hides itself so the storefront never shows a broken box.
*/
(function () {
  var STORAGE_KEY = 'badgehq_delivery_pin';
  var REQUEST_TIMEOUT_MS = 8000;

  function initWidget(root) {
    if (!root || root.hasAttribute('data-de-ready')) return;
    root.setAttribute('data-de-ready', '');

    var endpoint = root.getAttribute('data-de-endpoint');
    var shop = root.getAttribute('data-de-shop') || (window.Shopify && window.Shopify.shop) || '';
    var form = root.querySelector('[data-de-form]');
    var input = root.querySelector('[data-de-input]');
    var button = root.querySelector('[data-de-button]');
    var result = root.querySelector('[data-de-result]');
    if (!endpoint || !shop || !form || !input || !result) return;

    // Merchant-editable text from the block settings (data-* attributes).
    var textOpts = {
      deliverBy: root.getAttribute('data-de-deliverby') || 'Delivery by',
      freeDelivery: root.getAttribute('data-de-free') || '',
      fasterNote: root.getAttribute('data-de-faster') || ''
    };

    // Restore the shopper's last-used PIN so they don't retype it per product.
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved && /^\d{6}$/.test(saved)) {
        input.value = saved;
        check(saved); // show the estimate immediately on load
      }
    } catch (e) { /* private mode: ignore */ }

    // Only allow digits, max 6 (Indian PIN).
    input.addEventListener('input', function () {
      input.value = input.value.replace(/\D/g, '').slice(0, 6);
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var pin = input.value.trim();
      if (!/^\d{6}$/.test(pin)) {
        setState('error', 'Enter a valid 6-digit PIN code.');
        input.focus();
        return;
      }
      try { localStorage.setItem(STORAGE_KEY, pin); } catch (e2) {}
      check(pin);
    });

    function setState(state, html) {
      result.setAttribute('data-de-state', state);
      result.innerHTML = html;
    }

    function check(pin) {
      setState('loading', '<span class="de-spinner" aria-hidden="true"></span> Checking delivery time…');
      if (button) button.disabled = true;

      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);

      fetch(endpoint + '?shop=' + encodeURIComponent(shop) + '&pincode=' + encodeURIComponent(pin), {
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      })
        .then(function (r) {
          clearTimeout(timer);
          if (r.status === 404) throw new Error('setup-pending');
          if (!r.ok) throw new Error('bad-status');
          return r.json();
        })
        .then(function (data) {
          root.removeAttribute('data-de-hidden');
          var html = resultHtml(data, textOpts);
          if (html) {
            setState('ok', html);
          } else {
            setState('unserviceable',
              'Sorry, we don’t deliver to <strong>' + escapeHtml(pin) + '</strong> yet.');
          }
        })
        .catch(function (err) {
          clearTimeout(timer);
          if (err && err.message === 'setup-pending') {
            // Feature not configured in the BadgeHQ admin — hide the widget.
            setState('idle', '');
            root.setAttribute('data-de-hidden', '');
          } else {
            root.removeAttribute('data-de-hidden');
            setState('error', 'Couldn’t check right now. Please try again.');
          }
        })
        .finally(function () { if (button) button.disabled = false; });
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Build the "ok" result HTML from the EDD response. Returns '' when no
  // configured mode is serviceable. Shows a single "{deliverBy} {date}" row
  // using the fastest serviceable date (no standard/express labels), plus
  // optional merchant free-delivery and "faster at checkout" lines. The
  // top-level etaText path keeps old cached responses working.
  var CHECK_SVG =
    '<svg class="de-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">' +
    '<path fill="currentColor" d="M8 15.2 3.8 11l1.4-1.4L8 12.4l6.8-6.8L16.2 7 8 15.2z"/></svg>';
  var TRUCK_SVG =
    '<svg class="de-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
    '<path fill="currentColor" d="M3 4h11v9H3V4Zm12 3h3.5L21 10v3h-6V7ZM6.5 18a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm11 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z"/></svg>';

  function fastestServiceable(data) {
    if (Object.prototype.toString.call(data.modes) === '[object Array]') {
      var best = null;
      for (var i = 0; i < data.modes.length; i++) {
        var m = data.modes[i];
        if (!m || !m.serviceable || !(m.etaText || m.etaDate)) continue;
        if (!best || String(m.etaDate || '') < String(best.etaDate || '')) best = m;
      }
      if (best) return best;
    }
    if (data.serviceable && (data.etaText || data.etaDate)) {
      return { etaText: data.etaText, etaDate: data.etaDate };
    }
    return null;
  }

  function resultHtml(data, opts) {
    if (!data) return '';
    opts = opts || {};
    var best = fastestServiceable(data);
    if (!best) return '';
    var deliverBy = opts.deliverBy || 'Delivery by';
    var when = best.etaText || best.etaDate;
    var html =
      '<div class="de-widget__row">' + CHECK_SVG +
      '<span>' + escapeHtml(deliverBy) + ' <strong>' + escapeHtml(when) + '</strong></span></div>';
    if (opts.freeDelivery) {
      html += '<div class="de-widget__row">' + TRUCK_SVG +
        '<span>' + escapeHtml(opts.freeDelivery) + '</span></div>';
    }
    if (opts.fasterNote) {
      html += '<div class="de-widget__row de-widget__faster"><span>' +
        escapeHtml(opts.fasterNote) + '</span></div>';
    }
    return html;
  }

  function initAll() {
    var widgets = document.querySelectorAll('[data-delivery-estimate]');
    for (var i = 0; i < widgets.length; i++) initWidget(widgets[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
  // Re-init if the theme editor / section rendering re-renders the block.
  document.addEventListener('shopify:section:load', initAll);
})();
