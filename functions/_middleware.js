const VIP_HOST = "vipmember.robodigimart.com";
const MAIN_HOSTS = new Set(["robodigimart.com", "www.robodigimart.com"]);

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
  const hostname = requestUrl.hostname.toLowerCase();
  if (hostname !== VIP_HOST) {
    // Preserve the marketing site's existing root URL behavior without a
    // hostname-blind _redirects rule that would also catch the VIP subdomain.
    if (MAIN_HOSTS.has(hostname) && requestUrl.pathname === "/") {
      requestUrl.pathname = "/id";
      return Response.redirect(requestUrl, 302);
    }
    return context.next();
  }

  const destinationPath = VIP_PATHS.get(requestUrl.pathname);
  if (!destinationPath) return context.next();

  requestUrl.pathname = destinationPath;
  return context.next(new Request(requestUrl, context.request));
}
