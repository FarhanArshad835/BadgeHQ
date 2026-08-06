/**
 * P&L core: the Shopify order query, money math, and aggregation for the
 * profit dashboard.
 *
 * Hard rule enforced here: NO estimated costs. Every cost is an actual figure
 * or it is null ("pending" / "cost-per-item missing") — never zero, never a
 * guess. Money is integer MINOR UNITS (paise) as bigint throughout; the only
 * place a decimal string becomes a number is toMinor(), which never uses
 * parseFloat (float drift would corrupt every downstream sum).
 *
 * PCD-safe: the order query selects money + line items + fulfillment tracking
 * only — no name/address/customer PII, so it works under the app's Level-1
 * approval. Adding a PII field would make Shopify reject the whole query.
 */

/** Minimal admin GraphQL surface — same shape used across the app's server
 *  helpers (see order-actions.server.ts). */
export type AdminGraphql = {
  graphql: (query: string, opts?: { variables?: any }) => Promise<Response>;
};

/**
 * PII-free order selection. Money fields are financial, not customer data, so
 * they're outside the PCD gate. COGS rides inline on each line item's variant
 * (inventoryItem.unitCost) — one query per order, no N+1. Fulfillment
 * trackingInfo.number is the AWB we later match to the carrier's billed freight.
 */
const ORDER_PNL_FIELDS = `
  id
  name
  createdAt
  displayFinancialStatus
  displayFulfillmentStatus
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  totalRefundedSet { shopMoney { amount currencyCode } }
  totalDiscountsSet { shopMoney { amount currencyCode } }
  lineItems(first: 50) {
    nodes {
      quantity
      originalUnitPriceSet { shopMoney { amount } }
      discountedUnitPriceSet { shopMoney { amount } }
      product { id title }
      variant { id title inventoryItem { unitCost { amount currencyCode } } }
    }
  }
  fulfillments(first: 10) {
    trackingInfo { number company }
  }
`;

export type LineFinancials = {
  productId: string;
  variantId: string;
  productTitle: string;
  variantTitle: string;
  quantity: number;
  lineRevenueMinor: bigint;
  lineCogsMinor: bigint | null;
  lineCogsComplete: boolean;
};

export type OrderFinancialsComputed = {
  orderId: string;
  orderName: string;
  orderCreatedAt: Date;
  currency: string;
  grossRevenueMinor: bigint;
  refundsMinor: bigint;
  discountsMinor: bigint;
  cogsMinor: bigint | null;
  cogsComplete: boolean;
  financialStatus: string;
  fulfillmentStatus: string;
  awb: string;
  carrier: string;
  lines: LineFinancials[];
};

/**
 * Parse a Shopify decimal-string money amount ("123.45") into integer paise,
 * exactly, without ever touching parseFloat/Number on the fraction. This is the
 * single money-parsing chokepoint — everything downstream is bigint.
 */
export function toMinor(amount: unknown): bigint {
  const s = String(amount ?? "").trim();
  if (!s) return 0n;
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [wholeRaw, fracRaw = ""] = body.split(".");
  const whole = wholeRaw.replace(/\D/g, "") || "0";
  // Pad or truncate the fraction to exactly 2 digits (paise). Truncate, don't
  // round — we never invent a paisa the merchant wasn't charged.
  const frac = (fracRaw.replace(/\D/g, "") + "00").slice(0, 2);
  const minor = BigInt(whole) * 100n + BigInt(frac);
  return neg ? -minor : minor;
}

// formatMinor lives in the plain (non-.server) money.ts so the client can use
// it; re-exported here for server callers that import it from this module.
export { formatMinor } from "./money";

/** Extract the AWB + carrier from an order's fulfillments (first tracking
 *  number wins). Carrier name is normalised to our two known carriers. */
function pickTracking(node: any): { awb: string; carrier: string } {
  const fulfillments: any[] = node?.fulfillments ?? [];
  for (const f of fulfillments) {
    const info: any[] = f?.trackingInfo ?? [];
    for (const t of info) {
      const number = String(t?.number || "").trim();
      if (number) {
        const company = String(t?.company || "").toLowerCase();
        const carrier = /shiprocket/.test(company)
          ? "shiprocket"
          : /delhivery/.test(company)
          ? "delhivery"
          : "";
        return { awb: number, carrier };
      }
    }
  }
  return { awb: "", carrier: "" };
}

/**
 * Turn one Shopify order node into computed financials. Revenue and refunds are
 * always present; COGS is null-complete: if ANY sold line item has no
 * cost-per-item, cogsMinor stays null and cogsComplete is false (incomplete, not
 * zero).
 */
export function computeOrderFinancials(node: any): OrderFinancialsComputed {
  const currency =
    node?.currentTotalPriceSet?.shopMoney?.currencyCode || "INR";
  const grossRevenueMinor = toMinor(node?.currentTotalPriceSet?.shopMoney?.amount);
  const refundsMinor = toMinor(node?.totalRefundedSet?.shopMoney?.amount);
  const discountsMinor = toMinor(node?.totalDiscountsSet?.shopMoney?.amount);

  const lineNodes: any[] = node?.lineItems?.nodes ?? [];
  const lines: LineFinancials[] = [];
  let cogsMinor = 0n;
  let cogsComplete = true;

  for (const li of lineNodes) {
    const quantity = Number(li?.quantity ?? 0) || 0;
    // Revenue per line: what the customer paid (discounted unit price × qty).
    const unitPaid = toMinor(
      li?.discountedUnitPriceSet?.shopMoney?.amount ??
        li?.originalUnitPriceSet?.shopMoney?.amount,
    );
    const lineRevenueMinor = unitPaid * BigInt(quantity);

    // COGS per line from cost-per-item. Absent → this line (and the order) is
    // cogs-incomplete.
    const unitCostRaw = li?.variant?.inventoryItem?.unitCost?.amount;
    const hasCost = unitCostRaw != null && String(unitCostRaw).trim() !== "";
    const lineCogsMinor = hasCost ? toMinor(unitCostRaw) * BigInt(quantity) : null;
    if (hasCost && lineCogsMinor != null) {
      cogsMinor += lineCogsMinor;
    } else {
      cogsComplete = false;
    }

    lines.push({
      productId: String(li?.product?.id || ""),
      variantId: String(li?.variant?.id || ""),
      productTitle: String(li?.product?.title || ""),
      variantTitle: String(li?.variant?.title || ""),
      quantity,
      lineRevenueMinor,
      lineCogsMinor,
      lineCogsComplete: hasCost,
    });
  }

  const { awb, carrier } = pickTracking(node);

  return {
    orderId: String(node?.id || ""),
    orderName: String(node?.name || ""),
    orderCreatedAt: new Date(node?.createdAt || Date.now()),
    currency,
    grossRevenueMinor,
    refundsMinor,
    discountsMinor,
    // If COGS is incomplete, expose null (not the partial sum) so nothing
    // downstream treats a partial as the truth.
    cogsMinor: cogsComplete ? cogsMinor : null,
    cogsComplete,
    financialStatus: String(node?.displayFinancialStatus || ""),
    fulfillmentStatus: String(node?.displayFulfillmentStatus || ""),
    awb,
    carrier,
    lines,
  };
}

/**
 * Fetch one page of orders in a date window. Uses Shopify's `query` filter to
 * bound server-side. Returns nodes, the next cursor, and the GraphQL cost
 * throttle status so the caller can pace itself.
 */
export async function fetchOrdersPage(
  admin: AdminGraphql,
  opts: { createdAtMin: string; createdAtMax: string; cursor?: string | null },
): Promise<{
  nodes: any[];
  nextCursor: string | null;
  throttle: { currentlyAvailable: number; maximumAvailable: number } | null;
}> {
  const q = `created_at:>='${opts.createdAtMin}' AND created_at:<='${opts.createdAtMax}'`;
  const resp = await admin.graphql(
    `query PnlOrders($q: String!, $cursor: String) {
      orders(first: 50, query: $q, after: $cursor, sortKey: CREATED_AT) {
        nodes { ${ORDER_PNL_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    { variables: { q, cursor: opts.cursor ?? null } },
  );
  const body = await resp.json();
  const orders = body?.data?.orders;
  const nodes: any[] = orders?.nodes ?? [];
  const nextCursor = orders?.pageInfo?.hasNextPage ? orders?.pageInfo?.endCursor : null;
  const cost = body?.extensions?.cost?.throttleStatus;
  const throttle = cost
    ? {
        currentlyAvailable: Number(cost.currentlyAvailable ?? 0),
        maximumAvailable: Number(cost.maximumAvailable ?? 0),
      }
    : null;
  return { nodes, nextCursor, throttle };
}

// ── Aggregation for the dashboard ───────────────────────────────────────────

export type OrderRow = {
  orderCreatedAt: Date;
  grossRevenueMinor: bigint;
  refundsMinor: bigint;
  cogsMinor: bigint | null;
  cogsComplete: boolean;
  shippingCostMinor: bigint | null;
  shippingStatus: string;
  dataComplete: boolean;
};

export type Rollup = {
  orders: number;
  revenueMinor: bigint;
  refundsMinor: bigint;
  cogsMinor: bigint; // sum of KNOWN cogs only
  shippingMinor: bigint; // sum of KNOWN shipping only
  // Margin over orders with COMPLETE cost data — the trustworthy number.
  confirmedMarginMinor: bigint;
  // Margin over ALL orders using known costs (pending costs treated as gaps).
  provisionalMarginMinor: bigint;
};

/** Sum a set of order rows into one P&L. Pending/incomplete costs are summed
 *  only where known; the two margin figures make the gap explicit. */
export function rollup(rows: OrderRow[]): Rollup {
  let revenueMinor = 0n;
  let refundsMinor = 0n;
  let cogsMinor = 0n;
  let shippingMinor = 0n;
  let confirmedMarginMinor = 0n;

  for (const r of rows) {
    revenueMinor += r.grossRevenueMinor;
    refundsMinor += r.refundsMinor;
    if (r.cogsMinor != null) cogsMinor += r.cogsMinor;
    if (r.shippingCostMinor != null) shippingMinor += r.shippingCostMinor;
    if (r.dataComplete && r.cogsMinor != null && r.shippingCostMinor != null) {
      confirmedMarginMinor +=
        r.grossRevenueMinor - r.refundsMinor - r.cogsMinor - r.shippingCostMinor;
    }
  }

  // Provisional: revenue minus refunds minus all KNOWN costs. Pending costs are
  // simply absent (not estimated), so this is an upper bound the UI labels.
  const provisionalMarginMinor = revenueMinor - refundsMinor - cogsMinor - shippingMinor;

  return {
    orders: rows.length,
    revenueMinor,
    refundsMinor,
    cogsMinor,
    shippingMinor,
    confirmedMarginMinor,
    provisionalMarginMinor,
  };
}

export type Completeness = {
  total: number;
  cogsComplete: number;
  shippingBilled: number;
  fullyComplete: number;
  pct: number; // % of orders with complete cost data
};

/** How trustworthy is the P&L? The share of orders whose costs are fully known. */
export function completeness(rows: OrderRow[]): Completeness {
  const total = rows.length;
  let cogsCompleteN = 0;
  let shippingBilledN = 0;
  let fullyComplete = 0;
  for (const r of rows) {
    if (r.cogsComplete) cogsCompleteN++;
    if (r.shippingCostMinor != null) shippingBilledN++;
    if (r.dataComplete) fullyComplete++;
  }
  return {
    total,
    cogsComplete: cogsCompleteN,
    shippingBilled: shippingBilledN,
    fullyComplete,
    pct: total === 0 ? 0 : Math.round((fullyComplete / total) * 100),
  };
}
