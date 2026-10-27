export const PORT_IDS = [
  "outlet-1",
  "outlet-2",
  "dc-type-c",
  "dc-micro-usb",
  "dc-lightning",
  "wireless-pad",
];

export const PORT_ID_SET = new Set(PORT_IDS);
export const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
export const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
export const STATION_ID = String(process.env.CAMPUSVOLT_STATION_ID || "station-01")
  .toLowerCase()
  .replace(/[^a-z0-9_-]/g, "-")
  .slice(0, 48);

const HARDWARE_TTL_MS = 30_000;
export const RELAY_COMMAND_LEASE_MS = 15_000;
export const COIN_COLLECTION_TTL_SECONDS = 300;
export const ACCEPTED_COIN_DENOMINATIONS = [1, 5, 10, 20];

export function jsonResponse(status, payload) {
  return Response.json(payload, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export function configurationError() {
  return jsonResponse(503, {
    error: "Shared channel storage is not configured. Connect Upstash Redis to this Vercel project and redeploy.",
  });
}

export function portKey(portId) {
  return `campusvolt:${STATION_ID}:channel:${portId}`;
}

export function hardwareKey() {
  return `campusvolt:${STATION_ID}:hardware`;
}

export function coinCollectionKey() {
  return `campusvolt:${STATION_ID}:coin-collection`;
}

export function coinEventKey(eventId) {
  return `campusvolt:${STATION_ID}:coin-event:${eventId}`;
}

export function publicCoinCollection(value) {
  const collection = typeof value === "string" ? parseJson(value) : value;
  if (!collection || typeof collection !== "object") return null;
  const expiresAt = Number(collection.expiresAt) || 0;
  if (!expiresAt || expiresAt <= Date.now()) return null;
  return {
    collectionId: String(collection.collectionId || "").slice(0, 80),
    portId: PORT_ID_SET.has(collection.portId) ? collection.portId : null,
    targetAmount: Math.max(1, Math.min(120, Number(collection.targetAmount) || 1)),
    insertedAmount: Math.max(0, Math.min(120, Number(collection.insertedAmount) || 0)),
    eventCount: Math.max(0, Number(collection.eventCount) || 0),
    status: ["collecting", "ready", "consumed"].includes(collection.status)
      ? collection.status
      : "collecting",
    createdAt: Number(collection.createdAt) || null,
    updatedAt: Number(collection.updatedAt) || null,
    expiresAt,
    lastCoinAt: Number(collection.lastCoinAt) || null,
  };
}

export function buildCoinControl(collection, issuedAt = Date.now()) {
  const current = publicCoinCollection(collection);
  const enabled = Boolean(
    current
    && current.status === "collecting"
    && current.insertedAmount < current.targetAmount
    && current.expiresAt > issuedAt,
  );
  return {
    schemaVersion: 1,
    enabled,
    collectionId: current?.collectionId || null,
    portId: current?.portId || null,
    targetAmount: current?.targetAmount || 0,
    insertedAmount: current?.insertedAmount || 0,
    acceptedDenominations: ACCEPTED_COIN_DENOMINATIONS,
    validUntil: enabled ? Math.min(current.expiresAt, issuedAt + RELAY_COMMAND_LEASE_MS) : issuedAt + RELAY_COMMAND_LEASE_MS,
  };
}

export function buildRelayControl(sessions, issuedAt = Date.now()) {
  const activeByPort = new Map(
    (Array.isArray(sessions) ? sessions : [])
      .filter((session) => PORT_ID_SET.has(session?.portId) && Number(session?.endTime) > issuedAt)
      .map((session) => [session.portId, session]),
  );
  const fingerprint = [...activeByPort.values()]
    .sort((left, right) => left.portId.localeCompare(right.portId))
    .map((session) => `${session.portId}@${Number(session.endTime)}`)
    .join(",") || "all-off";
  const validUntil = issuedAt + RELAY_COMMAND_LEASE_MS;
  const channels = {};

  for (const portId of PORT_IDS) {
    const session = activeByPort.get(portId);
    channels[portId] = {
      relayOn: Boolean(session),
      authorizedUntil: session ? Math.min(Number(session.endTime), validUntil) : null,
    };
  }

  return {
    schemaVersion: 1,
    commandId: `relay:${fingerprint}`,
    issuedAt,
    validUntil,
    channels,
  };
}

export async function redis(command) {
  const result = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  const payload = await result.json();
  if (!result.ok || payload.error) {
    throw new Error(payload.error || `Redis returned HTTP ${result.status}`);
  }
  return payload.result;
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function publicHardwareState(value) {
  const hardware = typeof value === "string" ? parseJson(value) : value;
  const updatedAt = Number(hardware?.updatedAt) || 0;
  const online = Boolean(updatedAt && Date.now() - updatedAt <= HARDWARE_TTL_MS);
  const channels = {};

  for (const portId of PORT_IDS) {
    const source = online && hardware?.channels && typeof hardware.channels[portId] === "object"
      ? hardware.channels[portId]
      : {};
    channels[portId] = {
      inUse: Boolean(source.inUse),
      watts: Math.max(0, Number(source.watts) || 0),
      voltageV: Math.max(0, Number(source.voltageV) || 0),
      currentA: Math.max(0, Number(source.currentA) || 0),
      relayOn: Boolean(source.relayOn),
      fault: source.fault ? String(source.fault).slice(0, 80) : null,
    };
  }

  return {
    online,
    schemaVersion: online ? Number(hardware?.schemaVersion) || 1 : null,
    stationId: STATION_ID,
    messageId: online ? String(hardware?.messageId || "").slice(0, 80) || null : null,
    sentAt: online && hardware?.sentAt !== null && hardware?.sentAt !== undefined && Number.isFinite(Number(hardware.sentAt))
      ? Number(hardware.sentAt)
      : null,
    updatedAt: online ? updatedAt : null,
    latencyMs: online && hardware?.sentAt !== null && hardware?.sentAt !== undefined && Number.isFinite(Number(hardware.sentAt))
      ? Math.max(0, updatedAt - Number(hardware.sentAt))
      : null,
    firmwareVersion: online ? String(hardware?.firmwareVersion || "unknown").slice(0, 40) : null,
    lastAppliedCommandId: online
      ? String(hardware?.lastAppliedCommandId || "").slice(0, 256) || null
      : null,
    rssi: online && hardware?.rssi !== null && hardware?.rssi !== undefined && Number.isFinite(Number(hardware.rssi))
      ? Number(hardware.rssi)
      : null,
    channels,
    telemetry: online && hardware?.telemetry && typeof hardware.telemetry === "object"
      ? hardware.telemetry
      : null,
  };
}

export async function readSharedState() {
  const values = await redis([
    "MGET",
    ...PORT_IDS.map(portKey),
    hardwareKey(),
    coinCollectionKey(),
  ]);
  const rows = Array.isArray(values) ? values : [];
  const sessions = rows
    .slice(0, PORT_IDS.length)
    .map(parseJson)
    .filter(Boolean);
  const station = publicHardwareState(rows[PORT_IDS.length]);
  const coinCollection = publicCoinCollection(rows[PORT_IDS.length + 1]);
  return { sessions, station, coinCollection };
}
