import { useEffect, useState } from "react";
import { fetchConfigDetailed, fetchEligibility, requestCancel } from "./shared";

type Surface = "thank-you" | "account-new";

// UI primitives differ per target package (checkout vs customer-account) and
// have no shared import path, so each entrypoint injects the components it
// imported from its own package.
export type UiKit = {
  BlockStack: any;
  Button: any;
  Banner: any;
  Text: any;
};

/**
 * Shared "Cancel order" logic used by both extension targets. The target
 * wrappers pass in the resolved orderId, shop domain, a getToken() that returns
 * a fresh session-token JWT, which surface this is (to honor the merchant's
 * showOnPages setting), and the target's UI components.
 */
export function CancelBlock(props: {
  surface: Surface;
  orderId: string | null;
  shop: string;
  getToken: () => Promise<string | undefined>;
  ui: UiKit;
}) {
  const { surface, orderId, shop, getToken, ui } = props;
  const { BlockStack, Button, Banner, Text } = ui;
  // Two independent gates: config visibility (merchant-level) and per-order
  // eligibility. `visible` starts null = "still deciding".
  const [visible, setVisible] = useState<boolean | null>(null);
  // eligState: "loading" | "cancellable" | "blocked" | "unknown"
  const [eligState, setEligState] = useState<"loading" | "cancellable" | "blocked" | "unknown">("loading");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<null | "ok" | "error">(null);
  const [message, setMessage] = useState("");

  // Gate 1: is the feature enabled for this surface? (merchant config)
  useEffect(() => {
    let stop = false;
    (async () => {
      if (!shop) return; // no shop yet — wait
      const { config: cfg } = await fetchConfigDetailed(shop);
      if (stop) return;
      const on =
        !!cfg &&
        cfg.enabled &&
        cfg.allowCancel &&
        cfg.showOnPages.indexOf(surface) !== -1;
      setVisible(on);
    })();
    return () => {
      stop = true;
    };
  }, [shop, surface]);

  // Gate 2: per-order eligibility. On failure we DON'T hide — we fall back to
  // an enabled button (the POST re-checks server-side and rejects safely), so
  // a transient fetch problem never makes the whole feature invisible.
  useEffect(() => {
    let stop = false;
    (async () => {
      if (visible !== true || !orderId) return;
      setEligState("loading");
      const token = await getToken();
      if (stop) return;
      if (!token) { setEligState("unknown"); return; }
      const elig = await fetchEligibility(orderId, token);
      if (stop) return;
      if (!elig) { setEligState("unknown"); return; }
      setReason(elig.reason);
      setEligState(elig.cancellable ? "cancellable" : "blocked");
    })();
    return () => {
      stop = true;
    };
  }, [visible, orderId, getToken]);

  // Hide only when config is off for this surface, still resolving, or no order.
  if (visible !== true || !orderId) return null;

  async function onCancel() {
    setBusy(true);
    setDone(null);
    const token = await getToken();
    if (!token) {
      setBusy(false);
      setDone("error");
      setMessage("Couldn’t verify your session. Please try again.");
      return;
    }
    const res = await requestCancel(orderId as string, token);
    setBusy(false);
    if (res.ok) {
      setDone("ok");
      setMessage("Your order has been cancelled.");
    } else {
      setDone("error");
      setMessage(errorText(res.error));
    }
  }

  if (done === "ok") {
    return (
      <Banner status="success" title="Order cancelled">
        {message}
      </Banner>
    );
  }

  // Blocked (cancelled/fulfilled/prepaid) — show a disabled button + reason.
  if (eligState === "blocked") {
    const label =
      reason === "cancelled"
        ? "Order cancelled"
        : reason === "fulfilled"
        ? "Cancel unavailable"
        : "Cancel order";
    const note =
      reason === "cancelled"
        ? "This order has already been cancelled."
        : reason === "fulfilled"
        ? "This order has been shipped and can no longer be cancelled."
        : reason === "prepaid"
        ? "This order is prepaid — please contact us to cancel it."
        : "This order can’t be cancelled.";
    return (
      <BlockStack spacing="base">
        <Text>{note}</Text>
        <Button kind="secondary" disabled>
          {label}
        </Button>
      </BlockStack>
    );
  }

  // cancellable, still-loading, or eligibility-unknown -> show the active
  // button (server re-checks on POST). Loading spinner while eligibility loads.
  return (
    <BlockStack spacing="base">
      {done === "error" ? <Banner status="critical">{message}</Banner> : null}
      <Text>Changed your mind? You can cancel this order while it’s still unfulfilled.</Text>
      <Button kind="secondary" loading={busy || eligState === "loading"} onPress={onCancel}>
        Cancel order
      </Button>
    </BlockStack>
  );
}

function errorText(error?: string): string {
  switch (error) {
    case "not-cancellable":
      return "This order can no longer be cancelled.";
    case "not-owner":
    case "not-authorized":
      return "We couldn’t verify this order belongs to you.";
    case "not-enabled":
      return "Order cancellation isn’t available right now.";
    default:
      return "Couldn’t cancel right now. Please try again.";
  }
}
