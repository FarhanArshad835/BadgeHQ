import {
  reactExtension,
  useApi,
  useShop,
  useSessionToken,
  useSubscription,
  BlockStack,
  Button,
  Banner,
  Text,
} from "@shopify/ui-extensions-react/checkout";
import { CancelBlock } from "./CancelBlock";

export default reactExtension("purchase.thank-you.block.render", () => <ThankYou />);

function ThankYou() {
  const api = useApi();
  const sessionToken = useSessionToken();
  const shop = useShop();

  // orderConfirmation is a subscription; the created order's gid is at
  // orderConfirmation.order.id.
  const orderConfirmation = useSubscription((api as any).orderConfirmation);
  const orderId = orderConfirmation?.order?.id ?? null;

  return (
    <CancelBlock
      surface="thank-you"
      orderId={orderId}
      shop={shop?.myshopifyDomain ?? ""}
      getToken={() => sessionToken.get()}
      ui={{ BlockStack, Button, Banner, Text }}
    />
  );
}
