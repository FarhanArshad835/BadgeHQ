import { useEffect, useState } from "react";
import { fetchConfig, fetchEligibility, requestCancel } from "./shared";

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
  const [visible, setVisible] = useState(false);
  const [cancellable, setCancellable] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<null | "ok" | "error">(null);
  const [message, setMessage] = useState("");

  // Decide whether to render, and whether THIS order is cancellable, so we can
  // show the button greyed-out/disabled on cancelled/fulfilled/prepaid orders.
  useEffect(() => {
    let stop = false;
    (async () => {
      if (!orderId || !shop) return;
      const cfg = await fetchConfig(shop);
      if (stop) return;
      const on =
        !!cfg &&
        cfg.enabled &&
        cfg.allowCancel &&
        cfg.showOnPages.indexOf(surface) !== -1;
      setVisible(on);
      if (!on) return;
      const token = await getToken();
      if (stop || !token) return;
      const elig = await fetchEligibility(orderId, token);
      if (stop || !elig) return;
      setCancellable(elig.cancellable);
      setReason(elig.reason);
    })();
    return () => {
      stop = true;
    };
  }, [orderId, shop, surface, getToken]);

  if (!visible || !orderId) return null;

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

  // Not cancellable — show a disabled button with a reason, rather than hiding.
  if (!cancellable) {
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

  return (
    <BlockStack spacing="base">
      {done === "error" ? <Banner status="critical">{message}</Banner> : null}
      <Text>Changed your mind? You can cancel this order while it’s still unfulfilled.</Text>
      <Button kind="secondary" loading={busy} onPress={onCancel}>
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
