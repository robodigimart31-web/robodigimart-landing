import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { canonicalEntitlementPayload, validateEntitlementPolicy } from "../functions/_shared/portal.js";

// RFC 8032 test key only. It is never used by the production signer.
const TEST_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const TEST_PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const WRONG_PUBLIC = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
const seedDer = Buffer.from(`302e020100300506032b657004220420${TEST_SEED}`, "hex");
const testPrivateKey = createPrivateKey({ key: seedDer, format: "der", type: "pkcs8" });
const testPublicKey = createPublicKey({ key: Buffer.from(`302a300506032b6570032100${TEST_PUBLIC}`, "hex"), format: "der", type: "spki" });
const wrongPublicKey = createPublicKey({ key: Buffer.from(`302a300506032b6570032100${WRONG_PUBLIC}`, "hex"), format: "der", type: "spki" });

const fixture = () => ({
  license_scope: "helix_suite",
  license_id: "11111111-1111-4111-8111-111111111111",
  binding_id: "22222222-2222-4222-8222-222222222222",
  account_fingerprint: "a".repeat(64),
  status: "ACTIVE",
  license_expires_at: "2028-10-10T02:13:11.791Z",
  entitlement_version: 3,
  ea_product_id: "helix_quadriga",
  ea_version: "1.8a",
  allowed_products: ["helix_omega", "helix_quadriga"],
  issued_at: "2026-10-11T14:00:00.000Z",
  server_time: "2026-10-11T14:00:00.000Z",
  offline_expires_at: "2026-10-18T14:00:00.000Z",
});

const expected = {
  account_fingerprint: "a".repeat(64),
  product_is_registered: true,
  ea_product_id: "helix_quadriga",
  ea_version: "1.8a",
  minimum_entitlement_version: 3,
};

test("canonical entitlement uses fixed ordered UTF-8 JSON bytes", () => {
  const payload = canonicalEntitlementPayload(fixture());
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  assert.equal(bytes.toString("utf8"), `{"protocol_version":"v2","key_id":"helix-ed25519-5a081266524f5068","algorithm":"Ed25519","license_scope":"helix_suite","license_id":"11111111-1111-4111-8111-111111111111","binding_id":"22222222-2222-4222-8222-222222222222","account_fingerprint":"${"a".repeat(64)}","status":"ACTIVE","license_expires_at":"2028-10-10T02:13:11.791Z","entitlement_version":3,"ea_product_id":"helix_quadriga","ea_version":"1.8a","allowed_products":["helix_omega","helix_quadriga"],"issued_at":"2026-10-11T14:00:00.000Z","server_time":"2026-10-11T14:00:00.000Z","offline_expires_at":"2026-10-18T14:00:00.000Z"}`);
});

test("RFC test key signs a valid entitlement vector", () => {
  const bytes = Buffer.from(JSON.stringify(canonicalEntitlementPayload(fixture())), "utf8");
  const signature = sign(null, bytes, testPrivateKey);
  assert.equal(verify(null, bytes, testPublicKey, signature), true);
  assert.equal(validateEntitlementPolicy(canonicalEntitlementPayload(fixture()), expected, Date.parse("2026-10-11T14:00:00Z")), null);
});

test("tampered JSON bytes fail signature verification", () => {
  const bytes = Buffer.from(JSON.stringify(canonicalEntitlementPayload(fixture())), "utf8");
  const signature = sign(null, bytes, testPrivateKey);
  const altered = Buffer.from(bytes.toString("utf8").replace('"status":"ACTIVE"', '"status":"REVOKED"'), "utf8");
  assert.notDeepEqual(altered, bytes);
  assert.equal(verify(null, altered, testPublicKey, signature), false);
});

test("wrong public key fails signature verification", () => {
  const bytes = Buffer.from(JSON.stringify(canonicalEntitlementPayload(fixture())), "utf8");
  const signature = sign(null, bytes, testPrivateKey);
  assert.equal(verify(null, bytes, wrongPublicKey, signature), false);
});

test("expired entitlement is rejected", () => {
  const claims = canonicalEntitlementPayload({
    ...fixture(),
    license_expires_at: "2026-10-10T00:00:00Z",
    issued_at: "2026-10-09T00:00:00Z",
    server_time: "2026-10-09T00:00:00Z",
    offline_expires_at: "2026-10-10T00:00:00Z",
  });
  assert.equal(validateEntitlementPolicy(claims, expected, Date.parse("2026-10-11T14:00:00Z")), "LICENSE_EXPIRED");
});

test("suspended entitlement is rejected", () => {
  const claims = canonicalEntitlementPayload({ ...fixture(), status: "SUSPENDED" });
  assert.equal(validateEntitlementPolicy(claims, expected, Date.parse("2026-10-11T14:00:00Z")), "LICENSE_SUSPENDED");
});

test("wrong account fingerprint is rejected", () => {
  const claims = canonicalEntitlementPayload(fixture());
  assert.equal(validateEntitlementPolicy(claims, { ...expected, account_fingerprint: "b".repeat(64) }, Date.parse("2026-10-11T14:00:00Z")), "ACCOUNT_MISMATCH");
});

test("unregistered product, wrong product/version and older entitlement are rejected", () => {
  const claims = canonicalEntitlementPayload(fixture());
  assert.equal(validateEntitlementPolicy(claims, { ...expected, product_is_registered: false }, Date.parse("2026-10-11T14:00:00Z")), "PRODUCT_NOT_ALLOWED");
  assert.equal(validateEntitlementPolicy(claims, { ...expected, ea_product_id: "helix_future" }, Date.parse("2026-10-11T14:00:00Z")), "PRODUCT_NOT_ALLOWED");
  assert.equal(validateEntitlementPolicy(claims, { ...expected, ea_version: "9.9" }, Date.parse("2026-10-11T14:00:00Z")), "EA_VERSION_NOT_ALLOWED");
  assert.equal(validateEntitlementPolicy({ ...claims, entitlement_version: 2 }, expected, Date.parse("2026-10-11T14:00:00Z")), "STALE_ENTITLEMENT");
  assert.throws(() => canonicalEntitlementPayload({ ...fixture(), license_scope: "product", allowed_products: "all" }), /INVALID_ENTITLEMENT_CLAIMS/);
});
