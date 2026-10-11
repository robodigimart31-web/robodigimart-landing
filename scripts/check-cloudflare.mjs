import assert from "node:assert/strict";
import { readFile, readdir, stat, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../cloudflare-dist/", import.meta.url));
const read = name => readFile(path.join(root, name), "utf8");
let count = 0;
async function checkFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    assert(!entry.name.startsWith(".env") && entry.name !== ".git", "Private files in export");
    assert(entry.name !== "api", "Server API must not be in static export");
    if (entry.isDirectory()) await checkFiles(file);
    else {
      count++;
      assert((await stat(file)).size < 25 * 1024 * 1024, `Pages file limit: ${file}`);
    }
  }
}
await checkFiles(root);
assert(count < 20000, "Pages Free file count exceeded");
for (const locale of ["id", "en"]) {
  for (const suffix of ["", "/products/quadriga"]) {
    const html = await read(`${locale}${suffix}.html`);
    assert(html.includes(`lang="${locale}"`), "Wrong language");
    assert(html.includes(`https://www.robodigimart.com/${locale}${suffix}`), "Missing canonical");
    assert(html.includes("https://www.tiktok.com/@roboznapz"), "Missing contact");
    assert(!html.includes("/_next/image?"), "Image optimizer requires a server");
    for (const match of html.matchAll(/(?:src|href)="(\/(?:_next|images)[^"?]*)/g)) {
      await access(path.join(root, decodeURIComponent(match[1])));
    }
    if (!suffix) {
      assert.equal((html.match(/<details[\s>]/g) ?? []).length, 10, "All 10 FAQs must be in initial HTML");
      assert(html.includes("/images/optimized/"), "Responsive image variants missing");
    }
  }
}
await access(path.join(root, "404.html"));
assert((await read("sitemap.xml")).includes("/en/products/quadriga"));
assert((await read("robots.txt")).includes("sitemap.xml"));
assert(!(await read("_redirects")).split(/\r?\n/).some(line => /^\/\s+\/id\s/.test(line)), "Hostname-blind root redirect would send the VIP host to the landing page");
assert((await read("_headers")).includes("X-Content-Type-Options: nosniff"));
console.log(`PASS: ${count} files; 4 localized pages; FAQ; images; SEO; redirects; headers; no private APIs.`);
