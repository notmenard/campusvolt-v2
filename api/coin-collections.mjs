import { randomUUID } from "node:crypto";
import {
  COIN_COLLECTION_TTL_SECONDS,
  PORT_ID_SET,
  REDIS_TOKEN,
  REDIS_URL,
  STATION_ID,
  coinCollectionKey,
  configurationError,
  jsonResponse,
  publicCoinCollection,
  readSharedState,
  redis,
} from "./_campusvolt-redis.mjs";

export async function GET(request) {
  if (!REDIS_URL || !REDIS_TOKEN) return configurationError();
  const requestedId = new URL(request.url).searchParams.get("collectionId") || "";
  try {
    const collection = publicCoinCollection(await redis(["GET", coinCollectionKey()]));
    if (!collection || (requestedId && collection.collectionId !== requestedId)) {
      return jsonResponse(404, { error: "Coin collection not found or expired." });
    }
    return jsonResponse(200, { stationId: STATION_ID, collection });
  } catch (error) {
    console.error("Unable to read CampusVolt coin collection", error);
    return jsonResponse(502, { error: "Coin collection status is temporarily unavailable." });
  }
}

export async function POST(request) {
  if (!REDIS_URL || !REDIS_TOKEN) return configurationError();
  let input;
  try {
    input = await request.json();
  } catch {
    return jsonResponse(400, { error: "A JSON request body is required." });
  }

  const portId = String(input.portId || "");
  const targetAmount = Number(input.targetAmount);
  if (!PORT_ID_SET.has(portId) || !Number.isInteger(targetAmount) || targetAmount < 1 || targetAmount > 120) {
    return jsonResponse(400, { error: "Select a valid channel and a coin target from PHP 1 to PHP 120." });
  }

  try {
    const shared = await readSharedState();
    if (!shared.station.online) {
      return jsonResponse(409, { error: "The ESP32 station is offline, so the coin acceptor cannot be enabled." });
    }
    if (shared.sessions.some((session) => session.portId === portId)) {
      return jsonResponse(409, { error: "That channel already has an active charging session." });
    }
    if (shared.station.online && shared.station.channels[portId]?.fault) {
      return jsonResponse(409, { error: "The station reports a fault on that channel." });
    }

    const now = Date.now();
    const collection = {
      collectionId: `coins-${randomUUID()}`,
      portId,
      targetAmount,
      insertedAmount: 0,
      eventCount: 0,
      status: "collecting",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + COIN_COLLECTION_TTL_SECONDS * 1000,
      lastCoinAt: null,
    };
    const created = await redis([
      "SET",
      coinCollectionKey(),
      JSON.stringify(collection),
      "NX",
      "EX",
      COIN_COLLECTION_TTL_SECONDS,
    ]);
    if (created !== "OK") {
      const current = publicCoinCollection(await redis(["GET", coinCollectionKey()]));
      return jsonResponse(409, {
        error: "Another customer is already using the shared coin acceptor.",
        collection: current,
      });
    }
    return jsonResponse(201, { stationId: STATION_ID, collection });
  } catch (error) {
    console.error("Unable to open CampusVolt coin collection", error);
    return jsonResponse(502, { error: "The coin acceptor could not be reserved. Please try again." });
  }
}

export async function DELETE(request) {
  if (!REDIS_URL || !REDIS_TOKEN) return configurationError();
  let input;
  try {
    input = await request.json();
  } catch {
    return jsonResponse(400, { error: "A JSON request body is required." });
  }

  const collectionId = String(input.collectionId || "");
  try {
    const collection = publicCoinCollection(await redis(["GET", coinCollectionKey()]));
    if (!collection || collection.collectionId !== collectionId) {
      return jsonResponse(404, { error: "Coin collection not found or expired." });
    }
    if (collection.insertedAmount > 0) {
      return jsonResponse(409, { error: "A collection containing physical coins cannot be cancelled." });
    }
    await redis(["DEL", coinCollectionKey()]);
    return jsonResponse(200, { stationId: STATION_ID, cancelled: collectionId });
  } catch (error) {
    console.error("Unable to cancel CampusVolt coin collection", error);
    return jsonResponse(502, { error: "The coin collection could not be cancelled." });
  }
}
