/**
 * Money formatting — a plain (non-`.server`) module so both the P&L server code
 * and the client component can import it. It does no server work; it only turns
 * integer minor units (paise) into a display string. Kept out of `.server` files
 * because Remix strips those from the client bundle, and the P&L page renders
 * amounts on the client.
 */

/** Format integer paise as a rupee string, e.g. 105000n -> "₹1,050.00". Display
 *  edge only — never used in math. */
export function formatMinor(minor: bigint, currency = "INR"): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const rupees = abs / 100n;
  const paise = abs % 100n;
  const rupeeStr = new Intl.NumberFormat("en-IN").format(rupees);
  const sym = currency === "INR" ? "₹" : "";
  return `${neg ? "-" : ""}${sym}${rupeeStr}.${paise.toString().padStart(2, "0")}`;
}
