import { createHash, timingSafeEqual } from "node:crypto";
export function authorized(header: string | null, secret: string | undefined): boolean {
  if (!header?.startsWith("Bearer ") || !secret || secret.startsWith("YOUR_") || secret.length < 32) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
export function accountHash(login: string, broker: string): string {
  const salt = process.env.PUBLISHER_API_KEY;
  if (!salt) throw new Error("Missing publisher key");
  return createHash("sha256").update(`${salt}\u0000${broker}\u0000${login}`).digest("hex");
}
export function isFiniteNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
