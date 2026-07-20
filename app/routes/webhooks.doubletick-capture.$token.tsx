/**
 * TEMPORARY diagnostic — capture DoubleTick's real webhook payload.
 *
 * Real deliveries have never produced a bot reply while synthetic doc-shaped
 * payloads sail through, so either their live payload differs from their docs
 * (a fourth documented-vs-real gap would surprise nobody) or they stopped
 * delivering to our URL after the 401 era. This route answers which: a second
 * DoubleTick webhook points here, POSTs store the raw body, GET reads them
 * back. Kept in-house so live customer messages never touch a third party.
 *
 * DELETE this file (and the extra webhook, via their dashboard) once the
 * parser is fixed. Gated by the same unguessable-token scheme as the real
 * webhook; capture rows are inert (status "captured" is invisible to the
 * cron's pending-only queries).
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";

const CAPTURE_SHOP = "__dt_capture__";

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const token = String(params.token || "");
  if (!token) return new Response(null, { status: 200 });
  const settings = await prisma.aiReplySettings.findFirst({ where: { waWebhookToken: token } });
  if (!settings) return new Response(null, { status: 200 });

  const raw = await request.text().catch(() => "");
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => {
    headers[k] = k.toLowerCase() === "authorization" ? v.slice(0, 12) + "…" : v;
  });

  try {
    await prisma.whatsAppReplyJob.create({
      data: {
        shop: CAPTURE_SHOP,
        phone: "0",
        message: JSON.stringify({ headers, body: raw.slice(0, 8000) }),
        providerMessageId: `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        status: "captured",
      },
    });
  } catch (e) {
    console.error("[dt-capture] store failed", e);
  }
  return new Response(null, { status: 200 });
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const token = String(params.token || "");
  const settings = token
    ? await prisma.aiReplySettings.findFirst({ where: { waWebhookToken: token } })
    : null;
  if (!settings) return json({ error: "not-found" }, { status: 404 });

  const rows = await prisma.whatsAppReplyJob.findMany({
    where: { shop: CAPTURE_SHOP },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  return json({
    captures: rows.map((r) => ({ at: r.createdAt, payload: r.message })),
  });
};
