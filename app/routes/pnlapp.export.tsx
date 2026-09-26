/**
 * Per-order CSV for one month.
 *
 * Every figure the monthly statement aggregates, laid out one row per order, so
 * a total can be traced to the orders behind it rather than trusted. That is the
 * point: the statement says GST was Rs4.51 lakh, and this says which orders made
 * it up and at what slab.
 *
 * GST is recomputed here from the order's own lines using the SAME slab rules as
 * gstOutputSplit, not apportioned from the monthly total. Apportioning would
 * reconcile by construction and prove nothing; recomputing means the per-order
 * column and the statement agree only if both are right.
 *
 * Taxable value reconciles to the rupee. The TAX column sums to a few tens of
 * rupees below the statement (Rs49 on 6,937 August orders, ~0.7 paise each):
 * integer division truncates once per order here, but once per month there.
 * Both are correct at their own grain, and the statement stays the authority
 * for a filing.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { getPnlApp, isAuthed } from "../utils/pnl-app.server";
import { monthWindowIst } from "../utils/monthly-pnl.server";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** CSV cell: quote everything, double any embedded quote. */
function esc(v: unknown): string {
  return `"${String(v ?? "").replace(/"/g, '""')}"`;
}

/** Paise to rupees with 2dp, as a bare number so spreadsheets treat it as one. */
function rup(v: bigint | null | undefined): string {
  return v == null ? "" : (Number(v) / 100).toFixed(2);
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

  // Lines for every order in the month, in chunks: an `in` list of 13k ids is
  // rejected by the query planner well before it is slow.
  const lineByOrder = new Map<
    string,
    Array<{ productType: string; lineRevenueMinor: bigint; quantity: number; productTitle: string }>
  >();
  const ids = orders.map((o) => o.orderId);
  for (let i = 0; i < ids.length; i += 2000) {
    const rows = await prisma.orderLineFinancials.findMany({
      where: { shop, orderId: { in: ids.slice(i, i + 2000) } },
      select: {
        orderId: true,
        productType: true,
        lineRevenueMinor: true,
        quantity: true,
        productTitle: true,
      },
    });
    for (const r of rows) {
      const list = lineByOrder.get(r.orderId) ?? [];
      list.push(r);
      lineByOrder.set(r.orderId, list);
    }
  }

  // Same slab rules as gstOutputSplit, applied per order.
  const highTypes = new Set(
    app.gstHighTypes.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean),
  );
  const rateForLine = (l: { productType: string; lineRevenueMinor: bigint; quantity: number }) => {
    const type = (l.productType || "").trim().toLowerCase();
    if (!type) return app.gstOutputRateBp; // untyped: blended fallback
    if (highTypes.has(type)) return app.gstHighRateBp;
    const qty = BigInt(Math.max(1, l.quantity || 1));
    const unit = l.lineRevenueMinor / qty;
    return unit > app.gstFootwearThresholdMinor ? app.gstMidRateBp : app.gstStandardRateBp;
  };

  const head = [
    "order_name",
    "order_id",
    "created_ist",
    "delivery_status",
    "financial_status",
    "fulfillment_status",
    "awb",
    "carrier",
    "gross_revenue",
    "discounts",
    "refunds",
    "cogs",
    "cogs_complete",
    "shipping_cost",
    "shipping_status",
    "rto_cost",
    "cod_charge",
    // GST only applies to delivered orders, matching the statement.
    "gst_taxable",
    "gst_amount",
    "gst_slabs",
    "units",
    "products",
    "is_exchange_fee",
    "delivered_at_ist",
  ];

  const IST_MS = 5.5 * 60 * 60 * 1000;
  const ist = (d: Date | null | undefined) =>
    d ? new Date(d.getTime() + IST_MS).toISOString().slice(0, 19).replace("T", " ") : "";

  const rows: string[] = [head.join(",")];

  for (const o of orders) {
    const lines = lineByOrder.get(o.orderId) ?? [];

    // Delivered only, because that is the basis the monthly GST uses. A row for
    // an RTO order still shows its revenue, just no tax: nothing was sold.
    let taxable = 0n;
    let tax = 0n;
    const slabs = new Map<number, bigint>();
    if (o.deliveryStatus === "delivered") {
      for (const l of lines) {
        const rateBp = rateForLine(l);
        taxable += l.lineRevenueMinor;
        slabs.set(rateBp, (slabs.get(rateBp) ?? 0n) + l.lineRevenueMinor);
      }
      for (const [rateBp, base] of slabs) {
        // GST-inclusive: back the tax out rather than adding it on.
        tax += (base * BigInt(rateBp)) / BigInt(10000 + rateBp);
      }
    }

    const units = lines.reduce((s, l) => s + (l.quantity || 0), 0);
    const slabText = Array.from(slabs.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([bp, base]) => `${bp / 100}%: ${rup(base)}`)
      .join(" | ");

    rows.push(
      [
        esc(o.orderName),
        esc(o.orderId.replace(/^.*\//, "")),
        esc(ist(o.orderCreatedAt)),
        esc(o.deliveryStatus),
        esc(o.financialStatus),
        esc(o.fulfillmentStatus),
        esc(o.awb),
        esc(o.carrier),
        rup(o.grossRevenueMinor),
        rup(o.discountsMinor),
        rup(o.refundsMinor),
        rup(o.cogsMinor),
        esc(o.cogsComplete ? "yes" : "no"),
        rup(o.shippingCostMinor),
        esc(o.shippingStatus),
        rup(o.rtoCostMinor),
        rup(o.codChargeMinor),
        rup(taxable),
        rup(tax),
        esc(slabText),
        String(units),
        esc(lines.map((l) => l.productTitle).filter(Boolean).join(" | ")),
        esc(o.isExchangeFee ? "yes" : "no"),
        esc(ist(o.deliveredAt)),
      ].join(","),
    );
  }

  return new Response(rows.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="pnl-orders-${month}.csv"`,
      // A financial extract must never be served from a cache: the figures
      // change on every sync.
      "Cache-Control": "no-store",
    },
  });
};
