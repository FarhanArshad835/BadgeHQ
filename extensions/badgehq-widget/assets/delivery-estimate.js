/*
  BadgeHQ: PIN-code delivery-estimate widget (Delhivery).

  Talks to the BadgeHQ Cloudflare Worker at the endpoint given by the block's
  data-de-endpoint attribute, passing ?shop=&pincode=. The worker edge-caches
  and proxies to the BadgeHQ backend, which holds the merchant's Delhivery
  token — the token is NEVER in this file or the browser.

  Expected JSON response:
    { "serviceable": true,  "etaDate": "2026-07-22", "etaText": "Tue, 22 Jul" }
    { "serviceable": false }
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
          if (data && data.serviceable && (data.etaText || data.etaDate)) {
            var when = data.etaText || data.etaDate;
            setState('ok',
              '<svg class="de-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">' +
              '<path fill="currentColor" d="M8 15.2 3.8 11l1.4-1.4L8 12.4l6.8-6.8L16.2 7 8 15.2z"/></svg>' +
              'Delivery by <strong>' + escapeHtml(when) + '</strong>');
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
