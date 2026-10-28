import {
  PORT_ID_SET,
  REDIS_TOKEN,
  REDIS_URL,
  STATION_ID,
  configurationError,
  coinCollectionKey,
  jsonResponse,
  portKey,
  readSharedState,
  redis,
} from "./_campusvolt-redis.mjs";

export async function GET() {
  if (!REDIS_URL || !REDIS_TOKEN) return configurationError();
  try {
    const { sessions, station } = await readSharedState();
    return jsonResponse(200, { stationId: STATION_ID, sessions, station });
  } catch (error) {
    console.error("Unable to read CampusVolt channel state", error);
    return jsonResponse(502, { error: "Shared channel state is temporarily unavailable." });
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
  let durationMinutes = Number(input.durationMinutes);
  if (!PORT_ID_SET.has(portId) || !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 120) {
    return jsonResponse(400, { error: "Invalid channel or charging duration." });
  }

  try {
    const current = await readSharedState();
    if (current.station.online && current.station.channels[portId]?.fault) {
      return jsonResponse(409, {
        error: "Station reports a fault on this channel.",
        sessions: current.sessions,
        station: current.station,
      });
    }

    const collectionId = String(input.collectionId || "");
    const paymentMethod = String(input.method || "Cash").slice(0, 20);
    if (paymentMethod.toLowerCase() === "gcash") {
      return jsonResponse(503, { error: "GCash payments are temporarily unavailable." });
    }
    if (current.coinCollection?.portId === portId && current.coinCollection.collectionId !== collectionId) {
      return jsonResponse(409, { error: "That channel is reserved by an active cash payment." });
    }
    if (paymentMethod === "Cash" && !collectionId) {
      return jsonResponse(402, { error: "Cash sessions require a completed physical coin collection." });
    }
    if (collectionId) {
      const collection = current.coinCollection;
      if (!collection || collection.collectionId !== collectionId || collection.portId !== portId) {
        return jsonResponse(409, { error: "The physical coin collection is missing, expired, or belongs to another channel." });
      }
      if (collection.status !== "ready" || collection.insertedAmount < collection.targetAmount) {
        return jsonResponse(409, { error: "The selected coin amount has not been fully inserted." });
      }
      durationMinutes = collection.insertedAmount;
    }

    const now = Date.now();
    const durationMs = durationMinutes * 60_000;
    const session = {
      portId,
      portName: String(input.portName || portId).slice(0, 80),
      portType: String(input.portType || "outlet").slice(0, 40),
      spec: String(input.spec || "").slice(0, 200),
      device: String(input.device || "Phone").slice(0, 80),
      watts: portId === "wireless-pad" ? 10 : 9,
      paid: `PHP ${durationMinutes} - ${paymentMethod}`,
      durationMinutes,
      totalSeconds: durationMinutes * 60,
      remainingSeconds: durationMinutes * 60,
      cost: durationMinutes,
      startTime: now,
      endTime: now + durationMs,
      energyKWh: 0,
    };

    // Atomic web reservation: exactly one visitor can claim a channel.
    const reserved = await redis([
      "SET",
      portKey(portId),
      JSON.stringify(session),
      "NX",
      "PX",
      durationMs,
    ]);
    if (reserved !== "OK") {
      const latest = await readSharedState();
      return jsonResponse(409, {
        error: "That channel is already in use.",
        sessions: latest.sessions,
        station: latest.station,
      });
    }
    if (collectionId) await redis(["DEL", coinCollectionKey()]);
    return jsonResponse(201, { stationId: STATION_ID, session });
  } catch (error) {
    console.error("Unable to reserve CampusVolt channel", error);
    return jsonResponse(502, { error: "The channel could not be reserved. Please try again." });
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

  const portId = String(input.portId || "");
  if (!PORT_ID_SET.has(portId)) return jsonResponse(404, { error: "Channel not found." });

  try {
    await redis(["DEL", portKey(portId)]);
    return jsonResponse(200, { stationId: STATION_ID, released: portId });
  } catch (error) {
    console.error("Unable to release CampusVolt channel", error);
    return jsonResponse(502, { error: "The channel could not be released. Please try again." });
  }
}
