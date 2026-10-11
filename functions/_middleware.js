const VIP_HOST = "vipmember.robodigimart.com";

const VIP_PATHS = new Map([
  ["/", "/vip/"],
  ["/admin", "/vip/admin/"],
  ["/admin/", "/vip/admin/"],
  ["/login", "/vip/login/"],
  ["/login/", "/vip/login/"],
  ["/reset-password", "/vip/reset-password/"],
  ["/reset-password/", "/vip/reset-password/"],
]);

export async function onRequest(context) {
  const requestUrl = new URL(context.request.url);
  if (requestUrl.hostname.toLowerCase() !== VIP_HOST) return context.next();

  const destinationPath = VIP_PATHS.get(requestUrl.pathname);
  if (!destinationPath) return context.next();

  requestUrl.pathname = destinationPath;
  return context.next(new Request(requestUrl, context.request));
}
