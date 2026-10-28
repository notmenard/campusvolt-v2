import { randomUUID } from "node:crypto";
import { requireAdmin } from "./_admin-auth.mjs";
import {
  MAINTENANCE_PORT_ID_SET,
  REDIS_TOKEN,
  REDIS_URL,
  STATION_ID,
  configurationError,
  jsonResponse,
  maintenanceCoinKey,
  maintenanceKey,
  readSharedState,
  redis,
} from "./_campusvolt-redis.mjs";

const RELAY_TEST_SECONDS = 5;
const COIN_TEST_SECONDS = 120;

function publicState(shared) {
  return {
    stationId: STATION_ID,
    station: shared.station,
    activeSessions: shared.sessions,
    relayTest: shared.maintenance,
    coinTest: shared.maintenanceCoin,
  };
}

export async function GET(request) {
  if (!REDIS_URL || !REDIS_TOKEN) return configurationError();
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    return jsonResponse(200, publicState(await readSharedState()));
  } catch (error) {
    console.error("Unable to read maintenance state", error);
    return jsonResponse(502, { error: "Maintenance status is temporarily unavailable." });
  }
}

export async function POST(request) {
  if (!REDIS_URL || !REDIS_TOKEN) return configurationError();
  const denied = requireAdmin(request);
  if (denied) return denied;
  let input;
  try {
    input = await request.json();
  } catch {
    return jsonResponse(400, { error: "A JSON request body is required." });
  }

  try {
    const action = String(input.action || "");
    const shared = await readSharedState();
    if (action === "stop-all") {
      await redis(["DEL", maintenanceKey(), maintenanceCoinKey()]);
      return jsonResponse(200, { stopped: true });
    }
    if (!shared.station.online) return jsonResponse(409, { error: "The ESP32 station is offline." });

    if (action === "test-relay") {
      const portId = String(input.portId || "");
      if (!MAINTENANCE_PORT_ID_SET.has(portId)) {
        return jsonResponse(400, { error: "Only the four DC/HW-298 channels can be tested here." });
      }
      if (shared.sessions.length || shared.coinCollection) {
        return jsonResponse(409, { error: "A customer session or coin collection is active. Maintenance output tests are locked." });
      }
      if (shared.station.channels[portId]?.fault) {
        return jsonResponse(409, { error: "The ESP32 reports a fault on this channel." });
      }
      const now = Date.now();
      const relayTest = { portId, createdAt: now, expiresAt: now + RELAY_TEST_SECONDS * 1000 };
      await redis(["SET", maintenanceKey(), JSON.stringify(relayTest), "EX", RELAY_TEST_SECONDS + 2]);
      return jsonResponse(202, { relayTest });
    }

    if (action === "start-coin-test") {
      if (shared.coinCollection) {
        return jsonResponse(409, { error: "A customer is already using the coin acceptor." });
      }
      const now = Date.now();
      const coinTest = {
        collectionId: `maintenance-${randomUUID()}`,
        portId: "dc-type-c",
        targetAmount: 120,
        insertedAmount: 0,
        eventCount: 0,
        status: "collecting",
        createdAt: now,
        updatedAt: now,
        expiresAt: now + COIN_TEST_SECONDS * 1000,
        lastCoinAt: null,
      };
      await redis(["SET", maintenanceCoinKey(), JSON.stringify(coinTest), "EX", COIN_TEST_SECONDS]);
      return jsonResponse(201, { coinTest });
    }

    if (action === "stop-coin-test") {
      await redis(["DEL", maintenanceCoinKey()]);
      return jsonResponse(200, { stopped: true });
    }
    return jsonResponse(400, { error: "Unknown maintenance action." });
  } catch (error) {
    console.error("Unable to update maintenance state", error);
    return jsonResponse(502, { error: "The maintenance command could not be saved." });
  }
}
