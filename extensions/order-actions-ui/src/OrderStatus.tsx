import {
  reactExtension,
  useOrder,
  useShop,
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
  const sessionToken = useSessionToken();
  const shop = useShop();

  // useOrder() returns the current order subscription; its gid is order.id.
  const order = useOrder();
  const orderId = order?.id ?? null;

  return (
    <CancelBlock
      surface="account-new"
      orderId={orderId}
      shop={shop?.myshopifyDomain ?? ""}
      getToken={() => sessionToken.get()}
      ui={{ BlockStack, Button, Banner, Text }}
    />
  );
}
