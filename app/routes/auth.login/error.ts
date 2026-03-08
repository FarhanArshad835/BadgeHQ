export function loginErrorMessage(loginErrors: any) {
  if (loginErrors?.shop === "INVALID_SHOP") {
    return { shop: "Invalid shop domain" };
  }

  return { shop: null };
}
