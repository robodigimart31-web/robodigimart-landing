import type { ImageLoaderProps } from "next/image";

// These variants are generated at build time, so Pages needs no image server.
export default function staticImageLoader({ src, width }: ImageLoaderProps) {
  if (!/^\/images\/helix-(hero|quadriga|mountain)-scene\.png$/.test(src)) return src;
  const widths = [640, 960, 1280, 1920];
  const size = widths.find(candidate => candidate >= width) ?? 1920;
  return src.replace("/images/", "/images/optimized/").replace(".png", `-${size}.webp`);
}
