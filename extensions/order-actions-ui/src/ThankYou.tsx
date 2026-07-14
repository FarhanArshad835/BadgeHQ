import {
  reactExtension,
  useApi,
  useSessionToken,
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

  // On the thank-you page the order id comes from the order-confirmation API.
  const orderId =
    (api as any)?.orderConfirmation?.current?.order?.id ??
    (api as any)?.orderConfirmation?.current?.id ??
    null;

  const shop = (api as any)?.shop?.myshopifyDomain ?? "";

  return (
    <CancelBlock
      surface="thank-you"
      orderId={orderId}
      shop={shop}
      getToken={() => sessionToken.get()}
      ui={{ BlockStack, Button, Banner, Text }}
    />
  );
}
