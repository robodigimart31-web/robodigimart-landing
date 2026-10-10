import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import sharp from "sharp";

const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const stage = path.join(root, ".cloudflare-build");
const output = path.join(root, "cloudflare-dist");
// Only remove these exact, project-owned build directories, never user paths.
async function clearBuildDirectory(target) {
  if (path.dirname(target) !== root || ![".cloudflare-build", "cloudflare-dist"].includes(path.basename(target))) {
    throw new Error("Unsafe build directory");
  }
  try {
    if (await realpath(target) !== target) throw new Error("Build directory must not be a symlink");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await rm(target, { recursive: true, force: true });
}
await clearBuildDirectory(stage);
await clearBuildDirectory(output);
await mkdir(stage);

// Explicit allowlist: never copy .env, credentials, git metadata, or private APIs.
for (const name of ["app", "components", "lib", "public", "package.json", "tsconfig.json", "next-env.d.ts"]) {
  await cp(path.join(root, name), path.join(stage, name), {
    recursive: true,
    filter: source => source !== path.join(root, "app", "api"),
  });
}
await writeFile(path.join(stage, "next.config.mjs"), `export default {
  output: "export",
  poweredByHeader: false,
  reactStrictMode: true,
  images: {
    loader: "custom",
    loaderFile: "./lib/static-image-loader.ts",
    deviceSizes: [640, 960, 1280, 1920],
    imageSizes: [32, 64, 96, 128, 256, 384]
  }
};\n`);
for (const name of ["robots.ts", "sitemap.ts"]) {
  const target = path.join(stage, "app", name);
  await writeFile(target, `export const dynamic = "force-static";\n${await readFile(target, "utf8")}`);
}
const layout = path.join(stage, "app", "[locale]", "layout.tsx");
await writeFile(layout, `export const dynamicParams = false;\n${await readFile(layout, "utf8")}`);

const optimized = path.join(stage, "public", "images", "optimized");
await mkdir(optimized, { recursive: true });
for (const name of ["helix-hero-scene", "helix-quadriga-v2", "helix-mountain-scene"]) {
  for (const width of [640, 960, 1280, 1920]) {
    await sharp(path.join(root, "public", "images", `${name}.png`))
      .resize({ width, withoutEnlargement: true }).webp({ quality: 82 })
      .toFile(path.join(optimized, `${name}-${width}.webp`));
  }
}

const result = spawnSync(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "build"], {
  cwd: stage, stdio: "inherit",
  env: { ...process.env, NEXT_PUBLIC_STATIC_LANDING: "1", NEXT_TELEMETRY_DISABLED: "1" },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await cp(path.join(stage, "out"), output, { recursive: true });
await cp(path.join(root, "cloudflare", "_headers"), path.join(output, "_headers"));
await cp(path.join(root, "cloudflare", "_redirects"), path.join(output, "_redirects"));
console.log("Cloudflare Pages export ready: cloudflare-dist/");
