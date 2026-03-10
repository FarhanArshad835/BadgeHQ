import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  // If there's no shop or host param, the user is visiting directly —
  // send them to the login page to enter their shop domain.
  if (!url.searchParams.has("shop") && !url.searchParams.has("host")) {
    return redirect("/auth/login");
  }

  return redirect(`/app${url.search}`);
};
