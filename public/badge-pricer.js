/**
 * Price a collection card from the store's own discount rules.
 *
 * This is a PORT, not a reimplementation. bestOff() below is the same
 * algorithm the cart page has been running (jm-cart-pricer.js), verified
 * against the live cart on 2026-11-06 at 5/5 carts exact across SAVE100,
 * SAVE INR100, 2 FOR 649, 3 FOR 1949 and the 200 OFF rule that broke an
 * earlier hardcoded version. Keeping one algorithm is the point: a card that
 * quotes a saving the cart then contradicts is worse than a card with no
 * badge at all.
 *
 * Two deliberate differences from the cart's copy, both forced by context:
 *
 *   1. Scope is matched on PRODUCT HANDLE, not variant id. BadgeHQ's
 *      collection membership cache is keyed by handle (that is what a card's
 *      link exposes; most themes put no variant id in grid markup), whereas
 *      a cart line knows its variant. Same inScope() shape, different key.
 *
 *   2. There is no cart. A collection card asks a different question than the
 *      cart carousel does: not "what does this ADD to my bag" (which needs
 *      bag state) but "what does this offer save me at qty 1 vs its next
 *      tier" - a property of the rules and the product alone. So this exposes
 *      tierFor() rather than marginalFor().
 *
 * What is deliberately NOT claimed: Buy-X-get-Y and app-function discounts
 * are reported unsupported, and any computed figure outside a sane range
 * returns null, so the badge renders nothing rather than a wrong number.
 */
(function () {
  "use strict";

  if (window.badgeHQPricer) return;

  /** Does this line fall inside the rule's scope? Handle-keyed. */
  function inScope(rule, line, members) {
    if (rule.allItems) return true;

    // Named products. Shopify gives these as numeric product ids, and a grid
    // card knows its handle, so a product-scoped rule can only be matched
    // when the caller supplied the id too (the product page does; a card
    // normally does not). Checked before collections because it is cheaper.
    var prods = rule.products || [];
    if (prods.length && line.productId) {
      for (var k = 0; k < prods.length; k++) {
        if (String(prods[k]) === String(line.productId)) return true;
      }
    }

    var cols = rule.collections || [];
    for (var i = 0; i < cols.length; i++) {
      var m = members[cols[i]];
      // An unloaded collection is NOT an empty one. Returning false here
      // would quote a saving that ignores a rule which does apply, so the
      // caller is told to wait instead (see membershipReady).
      if (m && m.products && m.products[line.handle]) return true;
    }
    return false;
  }

  /**
   * The single best discount for these lines.
   *
   * Every automatic discount on this store has combinesWith all false, so
   * Shopify applies one at a time and the largest wins - confirmed against
   * the Admin API rather than assumed. If that ever changes, this becomes
   * wrong in the safe direction (it under-quotes), which is why the sync
   * stores the combines flags even though nothing reads them yet.
   */
  function bestOff(lines, data) {
    var best = 0;
    var rules = data.rules || [];
    var members = data.members || {};

    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (rule.unsupported) continue;
      var qty = 0, sub = 0, any = false;

      for (var k = 0; k < lines.length; k++) {
        if (!inScope(rule, lines[k], members)) continue;
        any = true;
        qty += lines[k].qty;
        sub += lines[k].qty * lines[k].price;
      }
      if (!any) continue;
      if (rule.minQty && qty < rule.minQty) continue;
      if (rule.minSubtotal && sub < rule.minSubtotal) continue;

      var off;
      if (rule.kind === "percent") off = sub * rule.percent;
      else if (rule.perItem) off = rule.amount * qty;
      else off = rule.amount;

      // A discount never takes more than the qualifying items are worth.
      if (off > sub) off = sub;
      if (off > best) best = off;
    }
    return best;
  }

  /**
   * Which rule, if any, this product could reach by buying MORE of it.
   *
   * Returns the smallest qty above 1 that unlocks a discount, because that is
   * the offer worth putting on a card: "buy 2" beats "buy 7" even if 7 saves
   * more in absolute terms. Quantity gates are read straight off the rule;
   * subtotal gates are converted into the qty that clears them AT THIS
   * PRODUCT'S PRICE, which is why two Rs799 items reach a Rs1500 gate and two
   * Rs649 items do not.
   *
   * Capped at MAX_TIER: a gate needing six of one item is not a message that
   * helps anyone on a collection card.
   */
  var MAX_TIER = 4;

  function nextTier(line, data) {
    var rules = data.rules || [];
    var members = data.members || {};
    var bestQty = 0;

    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (rule.unsupported) continue;
      if (!inScope(rule, line, members)) continue;

      var need = 0;
      if (rule.minQty) need = rule.minQty;
      if (rule.minSubtotal) {
        // Units of THIS product needed to clear the subtotal gate.
        var byValue = Math.ceil(rule.minSubtotal / line.price);
        if (byValue > need) need = byValue;
      }
      // A rule with no gate already applies at qty 1, so it is not a tier.
      if (need < 2) continue;
      if (need > MAX_TIER) continue;
      if (!bestQty || need < bestQty) bestQty = need;
    }
    return bestQty;
  }

  /**
   * Is enough membership loaded to answer honestly about THIS product?
   *
   * Not "is every collection loaded". A rule whose collections have all
   * loaded and which does not contain this product cannot change its answer,
   * so waiting on unrelated collections would blank the whole grid whenever
   * one collection was slow - the common case on a page where badges target
   * several collections at once.
   *
   * A rule is undecidable only when it names a collection that has NOT
   * loaded AND no loaded collection of that rule already matched. One of
   * those could still bring the product into scope, so the honest answer is
   * to wait rather than quote a figure that ignores it.
   */
  function membershipReady(line, data) {
    var rules = data.rules || [];
    var members = data.members || {};

    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (rule.unsupported) continue;
      // Already in scope by a decided path: nothing pending can change that.
      if (inScope(rule, line, members)) continue;

      var cols = rule.collections || [];
      for (var k = 0; k < cols.length; k++) {
        var m = members[cols[k]];
        if (!m || !m.loaded) return false;
      }
    }
    return true;
  }

  window.badgeHQPricer = {
    inScope: inScope,
    bestOff: bestOff,
    nextTier: nextTier,
    membershipReady: membershipReady,

    /**
     * What this product saves at qty 1, and at its next tier.
     *
     * `line`  { handle, price, productId? }  productId optional; without it a
     *                                        product-scoped rule cannot match.
     * `data`  { rules, members }             members is BadgeHQ's handle-keyed
     *                                        _collectionMembers map.
     * `compareAt`  the struck-through price, or 0 - the qty-1 saving is the
     *              compare-at gap, which is a different thing from a discount
     *              rule and must not be conflated with one.
     *
     * Returns null when nothing can be said honestly: no tier, membership
     * still loading, or a figure that fell outside a sane range. Callers must
     * treat null as "render no badge".
     */
    tierFor: function (line, data, compareAt) {
      if (!line || !(line.price > 0)) return null;
      if (!data || !data.rules || !data.rules.length) return null;

      var price = Number(line.price);
      var one = [{ handle: line.handle, productId: line.productId, price: price, qty: 1 }];
      if (!membershipReady(one[0], data)) return null;

      // Saving on a single unit: any rule that already applies at qty 1, plus
      // the compare-at gap. Kept separate so a card can show either.
      var ruleOff1 = bestOff(one, data);
      var cmp = Number(compareAt) || 0;
      var gap1 = cmp > price ? cmp - price : 0;

      var qty = nextTier(line, data);
      if (!qty) {
        // No reachable tier. Still useful if the product has a qty-1 rule or a
        // compare-at gap, so report those and let the caller decide.
        if (ruleOff1 <= 0 && gap1 <= 0) return null;
        return {
          tierQty: 0,
          save1: ruleOff1 + gap1,
          saveTier: 0,
          tierTotal: 0,
          tierEach: 0,
          extraSave: 0,
        };
      }

      var many = [{ handle: line.handle, productId: line.productId, price: price, qty: qty }];
      var gross = price * qty;
      var ruleOffN = bestOff(many, data);
      var tierTotal = gross - ruleOffN;

      // Sanity: a tier must cost something, must not cost more than list, and
      // must beat buying the same units without it. Anything else means the
      // model disagrees with reality - say nothing.
      if (!(tierTotal > 0) || tierTotal > gross + 0.01) return null;
      if (ruleOffN <= 0) return null;

      var saveTier = ruleOffN + gap1 * qty;

      return {
        tierQty: qty,
        /** Saving on one unit: qty-1 rule plus any compare-at gap. */
        save1: ruleOff1 + gap1,
        /** Total saving when buying the tier, including compare-at gaps. */
        saveTier: saveTier,
        /** What the tier costs in total, after the rule. */
        tierTotal: tierTotal,
        /** Effective per-unit price at the tier. */
        tierEach: tierTotal / qty,
        /** Extra saved by taking the tier rather than qty-1 pricing. */
        extraSave: saveTier - (ruleOff1 + gap1) * qty,
      };
    },
  };
})();
