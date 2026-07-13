/**
 * Delivery ETA math for the Delhivery Expected TAT integration.
 * delivery date = today (IST) + bufferDays business days + tat calendar days
 */

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** "Now" shifted to IST so late-evening requests don't compute a day early
 * (Vercel runs in UTC). The shifted Date is only used for date arithmetic
 * via the UTC getters below. */
function nowInIst(): Date {
  return new Date(Date.now() + IST_OFFSET_MS);
}

/** Add N business days (skip Sat/Sun). Operates on UTC fields of the
 * IST-shifted date. */
export function addBusinessDays(date: Date, n: number): Date {
  const d = new Date(date.getTime());
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) added++;
  }
  return d;
}

export function computeEtaDate(tat: number, bufferDays: number, now: Date = nowInIst()): Date {
  const afterDispatch = addBusinessDays(now, bufferDays);
  const eta = new Date(afterDispatch.getTime());
  eta.setUTCDate(eta.getUTCDate() + Number(tat));
  return eta;
}

export function formatEta(date: Date): { etaDate: string; etaText: string } {
  return {
    etaDate: date.toISOString().slice(0, 10),
    etaText: `${DAY_NAMES[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]}`,
  };
}

export const DELHIVERY_BASES: Record<string, string> = {
  staging: "https://staging-express.delhivery.com",
  production: "https://track.delhivery.com",
};

/** Call Delhivery Expected TAT. Returns the raw parsed JSON; throws on
 * non-2xx or network failure. */
export async function fetchDelhiveryTat(opts: {
  base: string;
  token: string;
  originPin: string;
  destinationPin: string;
}): Promise<any> {
  const url =
    `${opts.base}/api/dc/expected_tat` +
    `?origin_pin=${encodeURIComponent(opts.originPin)}` +
    `&destination_pin=${encodeURIComponent(opts.destinationPin)}` +
    `&mot=S`;

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Token ${opts.token}`,
    },
  });

  if (!res.ok) throw new Error(`delhivery ${res.status}`);
  return res.json();
}
