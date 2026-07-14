import {
  reactExtension,
  useApi,
  useSessionToken,
  BlockStack,
  Button,
  Banner,
  Text,
} from "@shopify/ui-extensions-react/customer-account";
import { CancelBlock } from "./CancelBlock";

export default reactExtension("customer-account.order-status.block.render", () => (
  <OrderStatus />
));

function OrderStatus() {
  const api = useApi();
  const sessionToken = useSessionToken();

  // On the customer-account order page the order id is on the order API object.
  const orderId =
    (api as any)?.order?.current?.id ?? (api as any)?.order?.id ?? null;

  const shop = (api as any)?.shop?.myshopifyDomain ?? "";

  return (
    <CancelBlock
      surface="account-new"
      orderId={orderId}
      shop={shop}
      getToken={() => sessionToken.get()}
      ui={{ BlockStack, Button, Banner, Text }}
    />
  );
}
