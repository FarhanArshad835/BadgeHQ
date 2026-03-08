import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, session, topic } =
    await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const current = (payload as any).current as string[];

  if (session) {
    await db.session.update({
      where: { id: session.id },
      data: { scope: current.toString() },
    });
  }

  return new Response();
};
