// BadgeHQ app backend that runs the cancel (authenticate.public.checkout).
export const BACKEND_ORIGIN = "https://badge-hq.vercel.app";
export const CANCEL_ENDPOINT = BACKEND_ORIGIN + "/api/order-cancel";
export const CONFIG_ENDPOINT = BACKEND_ORIGIN + "/api/widgets";

export type OrderMgmtConfig = {
  enabled: boolean;
  allowCancel: boolean;
  cancelScope: string;
  showOnPages: string[];
};

// Result carries an optional debug string so a fetch failure is diagnosable.
export type ConfigResult = { config: OrderMgmtConfig | null; debug: string };

// Fetch the merchant's order-management config for this shop. No custom headers
// (keeps it a CORS "simple" request → no preflight, which some extension
// network sandboxes block).
export async function fetchConfigDetailed(shop: string): Promise<ConfigResult> {
  try {
    const res = await fetch(CONFIG_ENDPOINT + "?shop=" + encodeURIComponent(shop));
    if (!res.ok) return { config: null, debug: "http-" + res.status };
    const data = await res.json();
    // The API nests feature configs under `widgets`.
    const om = data && data.widgets && data.widgets.orderManagement;
    if (!om) return { config: null, debug: "no-orderManagement-field" };
    return {
      config: {
        enabled: Boolean(om.enabled),
        allowCancel: om.allowCancel !== false,
        cancelScope: om.cancelScope || "unpaid",
        showOnPages: Array.isArray(om.showOnPages) ? om.showOnPages : ["account"],
      },
      debug: "ok",
    };
  } catch (e: any) {
    return { config: null, debug: "fetch-threw:" + String(e && e.message ? e.message : e).slice(0, 60) };
  }
}

export async function fetchConfig(shop: string): Promise<OrderMgmtConfig | null> {
  return (await fetchConfigDetailed(shop)).config;
}

export type Eligibility = {
  enabled: boolean;
  allowCancel: boolean;
  cancellable: boolean;
  reason: string;
};

// GET per-order eligibility (session-token authed) so we can show a
// greyed-out disabled button on orders that can't be cancelled.
export async function fetchEligibility(orderId: string, token: string): Promise<Eligibility | null> {
  try {
    // No custom headers -> CORS "simple" request -> NO preflight. Token goes
    // in the query string. (The Authorization-header form triggers a preflight
    // that the extension network sandbox blocks -> "Failed to fetch".)
    const res = await fetch(
      CANCEL_ENDPOINT + "?orderId=" + encodeURIComponent(orderId) + "&token=" + encodeURIComponent(token),
    );
    if (!res.ok) return null;
    const d = await res.json();
    if (!d || d.enabled === false) return null;
    return {
      enabled: true,
      allowCancel: d.allowCancel !== false,
      cancellable: Boolean(d.cancellable),
      reason: d.reason || "",
    };
  } catch {
    return null;
  }
}

// POST the cancel request. Sent as a CORS "simple" request: token in the body,
// Content-Type text/plain, no Authorization header -> no preflight. A
// preflighted POST (application/json + Authorization) is blocked by the
// extension network sandbox and surfaces as "Failed to fetch".
export async function requestCancel(orderId: string, token: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(CANCEL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ orderId, token }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data && data.ok) return { ok: true };
    // TEMP: surface the HTTP status + server error code for diagnosis.
    return { ok: false, error: (data && data.error) || ("http-" + res.status) };
  } catch (e: any) {
    return { ok: false, error: "network:" + String(e && e.message ? e.message : e).slice(0, 40) };
  }
}
