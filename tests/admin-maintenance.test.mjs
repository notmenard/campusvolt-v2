import assert from "node:assert/strict";
import test from "node:test";

process.env.CAMPUSVOLT_ADMIN_PASSWORD = "maintenance-test-password";
process.env.CAMPUSVOLT_STATION_API_KEY = "test-key-with-at-least-32-characters";

const { createAdminToken, isAdminAuthorized, verifyAdminPassword } = await import("../api/_admin-auth.mjs");
const { buildRelayControl } = await import("../api/_campusvolt-redis.mjs");

function requestWithCookie(token) {
  return new Request("https://campusvolt.example/api/maintenance", {
    headers: { Cookie: `campusvolt_admin=${encodeURIComponent(token)}` },
  });
}

test("admin password and signed session are verified server-side", () => {
  assert.equal(verifyAdminPassword("wrong"), false);
  assert.equal(verifyAdminPassword("maintenance-test-password"), true);
  const now = Date.now();
  const token = createAdminToken(now);
  assert.equal(isAdminAuthorized(requestWithCookie(token), now + 1000), true);
  assert.equal(isAdminAuthorized(requestWithCookie(`${token}x`), now + 1000), false);
  assert.equal(isAdminAuthorized(requestWithCookie(token), now + 31 * 60 * 1000), false);
});

test("maintenance relay test is leased and loses priority to customer sessions", () => {
  const now = Date.now();
  const maintenance = { portId: "dc-type-c", createdAt: now, expiresAt: now + 5000 };
  const testControl = buildRelayControl([], now, maintenance);
  assert.equal(testControl.channels["dc-type-c"].relayOn, true);
  assert.equal(testControl.channels["outlet-1"].relayOn, false);
  assert.ok(testControl.channels["dc-type-c"].authorizedUntil <= now + 5000);

  const paid = buildRelayControl([{ portId: "outlet-1", endTime: now + 60_000 }], now, maintenance);
  assert.equal(paid.channels["outlet-1"].relayOn, true);
  assert.equal(paid.channels["dc-type-c"].relayOn, false);
});
