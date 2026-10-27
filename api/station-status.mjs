import { timingSafeEqual } from "node:crypto";
import {
  PORT_IDS,
  REDIS_TOKEN,
  REDIS_URL,
  STATION_ID,
  configurationError,
  buildRelayControl,
  buildCoinControl,
  hardwareKey,
  jsonResponse,
  publicHardwareState,
  readSharedState,
  redis,
} from "./_campusvolt-redis.mjs";

const STATION_API_KEY = process.env.CAMPUSVOLT_STATION_API_KEY || "";
const HEARTBEAT_TTL_SECONDS = 30;
const SCHEMA_VERSION = 1;

function isAuthorized(request) {
  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const supplied = request.headers.get("x-campusvolt-key") || bearer;
  if (!STATION_API_KEY || !supplied) return false;
  const expectedBuffer = Buffer.from(STATION_API_KEY);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length
    && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function boundedNumber(value, minimum, maximum, fieldName) {
  if (typeof value === "boolean") {
    throw new TypeError(`${fieldName} must be a number from ${minimum} to ${maximum}.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new TypeError(`${fieldName} must be a number from ${minimum} to ${maximum}.`);
  }
  return number;
}

function optionalNumber(value, minimum, maximum, fieldName) {
  if (value === undefined || value === null) return null;
  return boundedNumber(value, minimum, maximum, fieldName);
}

function requiredBoolean(value, fieldName) {
  if (typeof value !== "boolean") throw new TypeError(`${fieldName} must be true or false.`);
  return value;
}

function normalizeChannel(source, portId) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError(`channels.${portId} must be an object.`);
  }
  const watts = boundedNumber(source.watts, 0, 500, `channels.${portId}.watts`);
  return {
    // Kept for schema-v1 compatibility only; channel availability is owned by paid sessions.
    inUse: source.inUse === undefined ? false : requiredBoolean(source.inUse, `channels.${portId}.inUse`),
    watts,
    voltageV: boundedNumber(source.voltageV, 0, 300, `channels.${portId}.voltageV`),
    currentA: boundedNumber(source.currentA, 0, 20, `channels.${portId}.currentA`),
    relayOn: requiredBoolean(source.relayOn, `channels.${portId}.relayOn`),
    fault: source.fault ? String(source.fault).trim().slice(0, 80) : null,
  };
}

function normalizeTelemetry(source) {
  if (source === undefined || source === null) return null;
  if (typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("telemetry must be an object.");
  }
  const battery = source.battery;
  const solar = source.solar;
  if (!battery || typeof battery !== "object" || Array.isArray(battery)) {
    throw new TypeError("telemetry.battery must be an object.");
  }
  if (!solar || typeof solar !== "object" || Array.isArray(solar)) {
    throw new TypeError("telemetry.solar must be an object.");
  }

  const powerW = boundedNumber(battery.powerW, -2000, 2000, "telemetry.battery.powerW");
  return {
    battery: {
      connected: requiredBoolean(battery.connected, "telemetry.battery.connected"),
      soc: boundedNumber(battery.soc, 0, 100, "telemetry.battery.soc"),
      voltageV: boundedNumber(battery.voltageV, 0, 100, "telemetry.battery.voltageV"),
      currentA: boundedNumber(battery.currentA, -200, 200, "telemetry.battery.currentA"),
      powerW,
      temperatureC: boundedNumber(battery.temperatureC, -40, 120, "telemetry.battery.temperatureC"),
      protection: String(battery.protection || "unknown").trim().slice(0, 40),
      status: String(battery.status || (powerW > 5 ? "charging" : powerW < -5 ? "discharging" : "idle")).trim().slice(0, 40),
      ratedCapacityAh: optionalNumber(battery.ratedCapacityAh, 1, 2000, "telemetry.battery.ratedCapacityAh"),
      ratedEnergyWh: optionalNumber(battery.ratedEnergyWh, 1, 100000, "telemetry.battery.ratedEnergyWh"),
      remainingAh: optionalNumber(battery.remainingAh, 0, 2000, "telemetry.battery.remainingAh"),
      remainingEnergyWh: optionalNumber(battery.remainingEnergyWh, 0, 100000, "telemetry.battery.remainingEnergyWh"),
      healthPercent: optionalNumber(battery.healthPercent, 0, 100, "telemetry.battery.healthPercent"),
      cycleCount: optionalNumber(battery.cycleCount, 0, 1000000, "telemetry.battery.cycleCount"),
      cellMinVoltageV: optionalNumber(battery.cellMinVoltageV, 0, 6, "telemetry.battery.cellMinVoltageV"),
      cellMaxVoltageV: optionalNumber(battery.cellMaxVoltageV, 0, 6, "telemetry.battery.cellMaxVoltageV"),
      cellDeltaMv: optionalNumber(battery.cellDeltaMv, 0, 6000, "telemetry.battery.cellDeltaMv"),
    },
    solar: {
      powerW: boundedNumber(solar.powerW, 0, 5000, "telemetry.solar.powerW"),
      energyTodayWh: optionalNumber(solar.energyTodayWh, 0, 1000000, "telemetry.solar.energyTodayWh"),
      peakPowerW: optionalNumber(solar.peakPowerW, 0, 5000, "telemetry.solar.peakPowerW"),
      panelVoltageV: optionalNumber(solar.panelVoltageV, 0, 200, "telemetry.solar.panelVoltageV"),
      controllerState: String(solar.controllerState || "unknown").trim().slice(0, 40),
    },
  };
}

export async function POST(request) {
  if (!REDIS_URL || !REDIS_TOKEN) return configurationError();
  if (!STATION_API_KEY) {
    return jsonResponse(503, { error: "CAMPUSVOLT_STATION_API_KEY is not configured." });
  }
  if (!isAuthorized(request)) return jsonResponse(401, { error: "Invalid station credentials." });

  const contentLength = Number(request.headers.get("content-length")) || 0;
  if (contentLength > 16_384) return jsonResponse(413, { error: "Station payload is too large." });

  let input;
  try {
    input = await request.json();
  } catch {
    return jsonResponse(400, { error: "A JSON request body is required." });
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return jsonResponse(400, { error: "The station payload must be a JSON object." });
  }

  if (input.stationId && String(input.stationId) !== STATION_ID) {
    return jsonResponse(409, { error: `This endpoint is configured for ${STATION_ID}.` });
  }

  let channels;
  let telemetry;
  let sentAt;
  let rssi;
  try {
    if (input.schemaVersion !== undefined && Number(input.schemaVersion) !== SCHEMA_VERSION) {
      throw new TypeError(`schemaVersion must be ${SCHEMA_VERSION}.`);
    }
    if (!input.channels || typeof input.channels !== "object" || Array.isArray(input.channels)) {
      throw new TypeError("channels must be an object containing all six channel IDs.");
    }
    channels = {};
    for (const portId of PORT_IDS) {
      if (!Object.hasOwn(input.channels, portId)) {
        throw new TypeError(`channels.${portId} is required.`);
      }
      channels[portId] = normalizeChannel(input.channels[portId], portId);
    }
    telemetry = normalizeTelemetry(input.telemetry);
    sentAt = optionalNumber(input.sentAt, 0, 9_007_199_254_740_991, "sentAt");
    rssi = optionalNumber(input.rssi, -120, 0, "rssi");
  } catch (error) {
    return jsonResponse(400, { error: error.message || "Invalid station payload." });
  }

  const receivedAt = Date.now();
  const hardware = {
    schemaVersion: SCHEMA_VERSION,
    stationId: STATION_ID,
    messageId: String(input.messageId || `${STATION_ID}-${receivedAt}`).trim().slice(0, 80),
    sentAt,
    updatedAt: receivedAt,
    firmwareVersion: String(input.firmwareVersion || "unknown").slice(0, 40),
    lastAppliedCommandId: String(input.lastAppliedCommandId || "").trim().slice(0, 256) || null,
    rssi,
    channels,
    telemetry,
  };

  try {
    await redis([
      "SET",
      hardwareKey(),
      JSON.stringify(hardware),
      "EX",
      HEARTBEAT_TTL_SECONDS,
    ]);
    const shared = await readSharedState();
    return jsonResponse(202, {
      accepted: true,
      heartbeatTtlSeconds: HEARTBEAT_TTL_SECONDS,
      station: shared.station.online ? shared.station : publicHardwareState(hardware),
      control: buildRelayControl(shared.sessions, receivedAt),
      coinControl: buildCoinControl(shared.coinCollection, receivedAt),
    });
  } catch (error) {
    console.error("Unable to save CampusVolt hardware heartbeat", error);
    return jsonResponse(502, { error: "Station telemetry could not be saved." });
  }
}
