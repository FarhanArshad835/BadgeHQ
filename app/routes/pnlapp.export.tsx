/**
 * Per-UNIT CSV for one month: one row per physical item sold.
 *
 * A line of "3 x Block Heel" becomes three rows, so the file can be pivoted by
 * product, variant, size or GST slab without anyone having to weight by
 * quantity first. That is the difference between a spreadsheet you can group
 * and one you have to fix before grouping.
 *
 * Money is split across a line's units by integer remainder: the first few
 * units carry an extra paisa so the rows sum EXACTLY back to the line. Dividing
 * and rounding would leak a paisa per line, which on 12,000 lines is real money
 * and, worse, would stop the file reconciling to the statement.
 *
 * GST is recomputed from the line's own slab rule, the same one gstOutputSplit
 * uses, rather than apportioned from the monthly total. Apportioning would
 * reconcile by construction and prove nothing.
 *
 * Taxable value reconciles to the rupee. The TAX column sums a little below the
 * statement (about Rs49 on 6,937 August orders, ~0.7 paise each): integer
 * division truncates per row here and once per month there. Both are right at
 * their own grain, and the statement stays the authority for a filing.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { getPnlApp, isAuthed } from "../utils/pnl-app.server";
import { monthWindowIst } from "../utils/monthly-pnl.server";
import { returnHqByOrder } from "../utils/returnhq.server";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** CSV cell: quote everything, double any embedded quote. */
function esc(v: unknown): string {
  return `"${String(v ?? "").replace(/"/g, '""')}"`;
}

/** Paise to rupees with 2dp, as a bare number so spreadsheets treat it as one. */
function rup(v: bigint | null | undefined): string {
  return v == null ? "" : (Number(v) / 100).toFixed(2);
}

/**
 * Split a paise amount across n units without losing a paisa.
 *
 * The remainder goes to the earliest units, so the parts always sum back to the
 * original. `null` in means `null` for every unit (an unknown COGS stays
 * unknown rather than becoming zero, which would read as free stock).
 */
function splitMinor(total: bigint | null, n: number): Array<bigint | null> {
  if (total == null) return Array(n).fill(null);
  if (n <= 0) return [];
  const each = total / BigInt(n);
  const rem = Number(total - each * BigInt(n));
  return Array.from({ length: n }, (_, i) => each + (i < rem ? 1n : 0n));
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthed(request)) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const month = url.searchParams.get("month") || "";
  if (!MONTH_RE.test(month)) return new Response("Bad month", { status: 400 });

  const app = await getPnlApp();
  const shop = app.shopDomain;
  if (!shop) return new Response("Not configured", { status: 400 });

  const { start, end } = monthWindowIst(month);

  const orders = await prisma.orderFinancials.findMany({
    where: { shop, orderCreatedAt: { gte: start, lt: end } },
    orderBy: { orderCreatedAt: "asc" },
  });
  const orderById = new Map(orders.map((o) => [o.orderId, o]));

  // Whether the customer returned or exchanged, from ReturnHQ's own database.
  // Shopify does not know: a return there is a refund, and these requests are
  // raised in ReturnHQ, so without this join the export cannot say which sales
  // actually stuck.
  const returnsByOrder = await returnHqByOrder(
    orders.map((o) => o.orderName).filter(Boolean),
  );

  // Lines in chunks: an `in` list of 13k ids is rejected by the query planner
  // well before it is slow.
  const ids = orders.map((o) => o.orderId);
  const allLines: Array<{
    orderId: string;
    productType: string;
    sku: string;
    quantity: number;
    lineRevenueMinor: bigint;
    lineCogsMinor: bigint | null;
    lineCogsComplete: boolean;
  }> = [];
  for (let i = 0; i < ids.length; i += 2000) {
    const rows = await prisma.orderLineFinancials.findMany({
      where: { shop, orderId: { in: ids.slice(i, i + 2000) } },
      select: {
        orderId: true,
        productType: true,
        sku: true,
        quantity: true,
        lineRevenueMinor: true,
        lineCogsMinor: true,
        lineCogsComplete: true,
      },
    });
    allLines.push(...rows);
  }

  // Same slab rules as gstOutputSplit.
  const highTypes = new Set(
    app.gstHighTypes.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean),
  );
  const rateForLine = (l: { productType: string; lineRevenueMinor: bigint; quantity: number }) => {
    const type = (l.productType || "").trim().toLowerCase();
    if (!type) return app.gstOutputRateBp; // untyped: blended fallback
    if (highTypes.has(type)) return app.gstHighRateBp;
    // Per-PAIR price decides the slab, so a multi-quantity line of cheap pairs
    // is not pushed over the threshold by its own total.
    const qty = BigInt(Math.max(1, l.quantity || 1));
    const unit = l.lineRevenueMinor / qty;
    return unit > app.gstFootwearThresholdMinor ? app.gstMidRateBp : app.gstStandardRateBp;
  };

  // Order-level costs (shipping, RTO, COD) belong to the ORDER, not the item,
  // so they are spread across that order's units. Summing them per product
  // would otherwise multiply one shipping charge by the basket size.
  const unitsPerOrder = new Map<string, number>();
  for (const l of allLines) {
    unitsPerOrder.set(l.orderId, (unitsPerOrder.get(l.orderId) ?? 0) + (l.quantity || 0));
  }

  const head = [
    "order_name",
    "order_id",
    "created_ist",
    "delivery_status",
    "financial_status",
    "awb",
    "carrier",
    "sku",
    "product_type",
    "unit_revenue",
    "unit_cogs",
    "cogs_known",
    "gst_rate_pct",
    "gst_taxable",
    "gst_amount",
    "unit_shipping_cost",
    "unit_refund",
    "return_type",
    "return_status",
    "line_qty",
    "unit_index",
    "delivered_at_ist",
  ];

  const IST_MS = 5.5 * 60 * 60 * 1000;
  const ist = (d: Date | null | undefined) =>
    d ? new Date(d.getTime() + IST_MS).toISOString().slice(0, 19).replace("T", " ") : "";

  const rows: string[] = [head.join(",")];

  // Order-level discounts live on the ORDER, not the line, so a line synced
  // before that was handled still carries its pre-discount price. Rather than
  // wait for a re-sync to correct months already on disk, scale each line down
  // so the order's lines sum to what was actually charged.
  //
  // grossRevenue is not used directly as the tax base because it can include
  // shipping charged to the customer (#227949 is Rs100 of pure shipping on a
  // fully discounted product), and a delivery charge must not be taxed at the
  // footwear slab.
  const lineTotalByOrder = new Map<string, bigint>();
  for (const l of allLines) {
    lineTotalByOrder.set(l.orderId, (lineTotalByOrder.get(l.orderId) ?? 0n) + l.lineRevenueMinor);
  }

  // Scaling truncates, so an order's scaled lines can land a paisa or two under
  // what was paid (#218077: 1248.99 against 1249.00). The shortfall goes to the
  // order's first line, so each order reconciles exactly.
  const scaledByOrder = new Map<string, bigint>();
  const firstLineOfOrder = new Map<string, number>();
  allLines.forEach((l, idx) => {
    const lineTotal = lineTotalByOrder.get(l.orderId) ?? 0n;
    const o = orderById.get(l.orderId);
    if (!o) return;
    if (!firstLineOfOrder.has(l.orderId)) firstLineOfOrder.set(l.orderId, idx);
    const paid = o.grossRevenueMinor < lineTotal ? o.grossRevenueMinor : lineTotal;
    const scaled = lineTotal > 0n ? (l.lineRevenueMinor * paid) / lineTotal : 0n;
    scaledByOrder.set(l.orderId, (scaledByOrder.get(l.orderId) ?? 0n) + scaled);
  });

  for (let li = 0; li < allLines.length; li++) {
    const l = allLines[li];
    const o = orderById.get(l.orderId);
    if (!o) continue;
    const qty = Math.max(0, l.quantity || 0);
    if (qty === 0) continue;

    // What this line is worth once the order's discount is accounted for.
    // Only ever scales DOWN: if the lines already reconcile (a re-synced order)
    // or the order total exceeds them (shipping), the line is left alone.
    const lineTotal = lineTotalByOrder.get(l.orderId) ?? 0n;
    const paidForGoods =
      o.grossRevenueMinor < lineTotal ? o.grossRevenueMinor : lineTotal;
    const scaledBase =
      lineTotal > 0n ? (l.lineRevenueMinor * paidForGoods) / lineTotal : 0n;
    // The first line of the order absorbs the truncation shortfall.
    const isFirst = firstLineOfOrder.get(l.orderId) === li;
    const shortfall = isFirst
      ? paidForGoods - (scaledByOrder.get(l.orderId) ?? 0n)
      : 0n;
    const effectiveLineMinor = scaledBase + shortfall;

    const rev = splitMinor(effectiveLineMinor, qty);
    const cogs = splitMinor(l.lineCogsMinor, qty);

    // The order's own costs, spread over every unit in the order.
    const orderUnits = unitsPerOrder.get(l.orderId) || qty;
    const shipPer = splitMinor(o.shippingCostMinor, orderUnits);
    const refundPer = splitMinor(o.refundsMinor, orderUnits);

    // Slab from the price actually charged per pair: a Rs1,100 pair discounted
    // to Rs900 belongs in the 5% band, not the 12% one.
    const rhq = returnsByOrder.get(o.orderName);
    const rateBp = rateForLine({
      productType: l.productType,
      lineRevenueMinor: effectiveLineMinor,
      quantity: qty,
    });
    const delivered = o.deliveryStatus === "delivered";

    for (let u = 0; u < qty; u++) {
      const unitRev = rev[u] ?? 0n;
      // GST only on delivered units, matching the delivered basis the statement
      // uses: an RTO row keeps its revenue but carries no tax, nothing was sold.
      const taxable = delivered ? unitRev : 0n;
      const tax = delivered ? (taxable * BigInt(rateBp)) / BigInt(10000 + rateBp) : 0n;

      rows.push(
        [
          esc(o.orderName),
          esc(o.orderId.replace(/^.*\//, "")),
          esc(ist(o.orderCreatedAt)),
          esc(o.deliveryStatus),
          esc(o.financialStatus),
          esc(o.awb),
          esc(o.carrier),
          esc(l.sku),
          esc(l.productType),
          rup(unitRev),
          rup(cogs[u]),
          esc(l.lineCogsComplete ? "yes" : "no"),
          (rateBp / 100).toFixed(2),
          rup(taxable),
          rup(tax),
          rup(shipPer[u] ?? null),
          rup(refundPer[u] ?? null),
          esc(rhq?.type ?? ""),
          esc(rhq?.status ?? ""),
          String(qty),
          String(u + 1),
          esc(ist(o.deliveredAt)),
        ].join(","),
      );
    }
  }

  return new Response(rows.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="pnl-units-${month}.csv"`,
      // A financial extract must never be served from a cache: the figures
      // change on every sync.
      "Cache-Control": "no-store",
    },
  });
};
