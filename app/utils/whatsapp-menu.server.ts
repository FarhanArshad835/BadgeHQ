/**
 * The deterministic support menu — a BadgeHQ replication of the merchant's
 * DoubleTick flow bot ("chatwithsupport_v6"), answered in code at zero LLM
 * cost.
 *
 * Why replicate it here: the flow bot triggers on ".." with partial match, so
 * it fired on EVERY message in parallel with the AI — two bots answering each
 * customer — while the AI burned ~2.3K tokens on questions the button menu
 * already answered ("return policy", "track my order"). Owning the menu means
 * one responder, and the LLM is reserved for questions no canned answer
 * covers.
 *
 * Reply texts are copied verbatim from the merchant's flow (screenshots,
 * 2026-07-22), with the URL-button links inlined as bare URLs since plain
 * sends have no buttons.
 */

export type MenuIntent =
  | "track"
  | "cancel"
  | "return"
  | "refund"
  | "shipping"
  | "size"
  | "human";

/** Rows for the interactive list message (DoubleTick, max 10 rows). */
export const MENU_ROWS: { id: string; title: string; description?: string }[] = [
  { id: "menu_track", title: "Order Tracking", description: "Track your parcel" },
  { id: "menu_cancel", title: "Order Cancellation", description: "Cancel before dispatch" },
  { id: "menu_return", title: "Return/Exchange", description: "Raise a request" },
  { id: "menu_refund", title: "Refund", description: "How refunds work" },
  { id: "menu_shipping", title: "Shipping terms", description: "Delivery & COD" },
  { id: "menu_size", title: "Size Chart", description: "Find your size" },
  { id: "menu_human", title: "Talk to Us", description: "Reach our team" },
];

export const MENU_BODY =
  "Thanks for reaching out JM Looks, you can use the menu to interact with us more easily!";
export const MENU_BUTTON = "Choose an option";

/** Canned answers, verbatim from the merchant's flow. */
export const MENU_REPLIES: Record<Exclude<MenuIntent, "human">, string> = {
  track:
    "Use Order Id or AWB to track your parcel..\n\nTrack here: https://jmlooks.shiprocket.co/",
  cancel:
    "You can cancel your order if it hasn't been shipped yet.\n\n" +
    "If you haven't received tracking details, visit the Order Details page and cancel your order:\n" +
    "https://shopify.com/82951569700/account/orders",
  return:
    "Raise a return or exchange request in a few easy steps. Reverse shipment charges apply per pair.\n\n" +
    "1. Visit: https://returnhq-web.vercel.app/portal/b03304\n" +
    "2. Enter your order number and email or mobile\n" +
    "3. Select items, fill in details and pay\n\n" +
    "Pickup: 2-3 days. Delivery: 1-3 days after pickup, depending on location.\n\n" +
    "Please check our return and exchange policy first: https://jmlooks.com/pages/exchange-policy",
  refund:
    "Refunds are processed after reverse pickup is done:\n" +
    "Prepaid: Refunded to original payment method.\n" +
    "COD: We will send a payout link, fill your preferred payout details; once you submit, the refund will be processed.",
  shipping:
    "We offer free shipping and cash on delivery for all orders across India. " +
    "Reliable courier services like Bluedart, Delhivery, Xpressbees, and Ekart handle the deliveries.",
  size:
    "If you have any doubt in size you can check our size chart.\n\n" +
    "https://jmlooks.com/pages/size-chart",
};

/** The flow's "Talk to Us" branch: hours-aware, then a human takes the thread. */
export const HANDOVER_REPLY =
  "Got it! I am handing over the chat to our customer delight team for assistance. " +
  "Please note it will take some time for them to respond to your request.";
export const OFF_HOURS_REPLY =
  "Hey there! Thanks for reaching out. We are available to help you from 10:00 AM to 7:00 PM " +
  "on Monday to Saturday. Please leave a message, we will respond once we are back.";

/** Mon-Sat 10:00-19:00 IST, matching the flow's Condition nodes. */
export function isBusinessHoursIST(now = new Date()): boolean {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const day = ist.getUTCDay(); // 0 = Sunday
  if (day === 0) return false;
  const hour = ist.getUTCHours();
  return hour >= 10 && hour < 19;
}

/**
 * Map a message to a menu intent — button taps by id/title, typed text by
 * keyword.
 *
 * Deliberately conservative on typed text: only short messages match, because
 * "I want to exchange my products" deserves the canned steps, but a paragraph
 * describing a damaged parcel with an exchange mention deserves the AI (or a
 * human), not a boilerplate link. Button taps match at any length since the
 * text IS the button.
 */
export function matchMenuIntent(text: string): MenuIntent | null {
  const t = String(text || "").trim();
  if (!t) return null;

  // Exact button/list taps — DoubleTick delivers the tapped id or title as the
  // message body.
  const exact: Record<string, MenuIntent> = {
    menu_track: "track",
    menu_cancel: "cancel",
    menu_return: "return",
    menu_refund: "refund",
    menu_shipping: "shipping",
    menu_size: "size",
    menu_human: "human",
    "order tracking": "track",
    "order cancellation": "cancel",
    "return/exchange": "return",
    refund: "refund",
    "shipping terms": "shipping",
    "size chart": "size",
    "talk to us": "human",
  };
  const hit = exact[t.toLowerCase()];
  if (hit) return hit;

  // Typed questions. Long messages carry context a canned reply would ignore.
  if (t.length > 120) return null;
  const s = t.toLowerCase();

  // A message can carry two questions — "I want to exchange, also do you have
  // COD?" — and a canned reply would answer the first and silently ignore the
  // second, which reads as not listening. Two guards, both free:
  //   1. If the text matches MORE THAN ONE intent, it is a compound question.
  //   2. If it matches one intent but also carries a joining word or a second
  //      sentence, there is probably a second ask the canned text won't cover.
  // Either way the AI takes it: it sees the knowledge base and can answer both
  // parts. The bias is deliberate — spending tokens beats half-answering.
  const intentChecks: [MenuIntent, RegExp][] = [
    ["track", /\b(track|tracking)\b|where\s+is\s+(my|the)\s+(order|parcel|package|shipment)/],
    ["cancel", /\bcancel/],
    ["return", /\b(return|exchange)\b/],
    ["refund", /\brefund/],
    ["shipping", /\b(shipping|courier|cod|cash on delivery|delivery charge)/],
    ["size", /\bsize\b/],
  ];
  const matched = intentChecks.filter(([, re]) => re.test(s)).map(([k]) => k);
  if (matched.length !== 1) return null;

  const hasSecondClause =
    /[?][^?]*[?]/.test(t) || // two question marks
    /\b(and|also|but|plus|as well|aur|bhi)\b/.test(s) ||
    /[.?!]\s+\S/.test(t); // a second sentence
  if (hasSecondClause) return null;

  return matched[0];
}
