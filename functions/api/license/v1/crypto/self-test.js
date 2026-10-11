import { json, LICENSE_SIGNING_KEY_ID, LICENSE_SIGNING_PUBLIC_KEY_HEX } from "../../../../_shared/portal.js";

const toBytes = hex => Uint8Array.from(hex.match(/.{2}/g) || [], value => Number.parseInt(value, 16));
const toBase64Url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");

export async function onRequestGet({ env }) {
  try {
    if (!env.LICENSE_SIGNING_PRIVATE_KEY_PKCS8) return json({ ok: false, error: "SIGNING_KEY_NOT_CONFIGURED" }, 503);
    const encoded = env.LICENSE_SIGNING_PRIVATE_KEY_PKCS8.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
    const der = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    const privateKey = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
    const publicBytes = toBytes(LICENSE_SIGNING_PUBLIC_KEY_HEX);
    const publicKey = await crypto.subtle.importKey("raw", publicBytes, { name: "Ed25519" }, false, ["verify"]);
    const message = new TextEncoder().encode(`HELIX-PRODUCTION-ED25519-SELF-TEST-V1:${LICENSE_SIGNING_KEY_ID}`);
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, message));
    const verified = await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, message);
    const altered = message.slice();
    altered[altered.length - 1] ^= 1;
    const tamperedRejected = !(await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, altered));
    const wrongPublic = await crypto.subtle.importKey("raw", toBytes("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"), { name: "Ed25519" }, false, ["verify"]);
    const wrongKeyRejected = !(await crypto.subtle.verify({ name: "Ed25519" }, wrongPublic, signature, message));
    return json({
      ok: verified && tamperedRejected && wrongKeyRejected,
      purpose: "fixed-message-key-pair-self-test-only",
      key_id: LICENSE_SIGNING_KEY_ID,
      public_key_raw_hex: LICENSE_SIGNING_PUBLIC_KEY_HEX,
      message_utf8_base64url: toBase64Url(message),
      signature_base64url: toBase64Url(signature),
      checks: { production_key_matches: verified, tampered_message_rejected: tamperedRejected, wrong_public_key_rejected: wrongKeyRejected },
    }, verified && tamperedRejected && wrongKeyRejected ? 200 : 503);
  } catch {
    return json({ ok: false, error: "SIGNING_SELF_TEST_FAILED" }, 503);
  }
}
