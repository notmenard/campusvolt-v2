import { timingSafeEqual } from "node:crypto";
import {
  ACCEPTED_COIN_DENOMINATIONS,
  REDIS_TOKEN,
  REDIS_URL,
  STATION_ID,
  coinCollectionKey,
  coinEventKey,
  configurationError,
  jsonResponse,
  publicCoinCollection,
  redis,
} from "./_campusvolt-redis.mjs";

const STATION_API_KEY = process.env.CAMPUSVOLT_STATION_API_KEY || "";

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

const ACCEPT_COIN_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local collection = cjson.decode(raw)
if collection.collectionId ~= ARGV[1] then return {'mismatch'} end
if collection.status ~= 'collecting' and collection.status ~= 'ready' then return {'closed'} end
if redis.call('EXISTS', KEYS[2]) == 1 then return {'duplicate', raw} end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 1 then return {'expired'} end
collection.insertedAmount = math.min(120, (tonumber(collection.insertedAmount) or 0) + tonumber(ARGV[2]))
collection.eventCount = (tonumber(collection.eventCount) or 0) + 1
collection.updatedAt = tonumber(ARGV[3])
collection.lastCoinAt = tonumber(ARGV[3])
if collection.insertedAmount >= tonumber(collection.targetAmount) then collection.status = 'ready' end
local updated = cjson.encode(collection)
redis.call('SET', KEYS[1], updated, 'EX', ttl)
redis.call('SET', KEYS[2], '1', 'EX', 600)
return {'accepted', updated}
`;

export async function POST(request) {
  if (!REDIS_URL || !REDIS_TOKEN) return configurationError();
  if (!STATION_API_KEY) return jsonResponse(503, { error: "CAMPUSVOLT_STATION_API_KEY is not configured." });
  if (!isAuthorized(request)) return jsonResponse(401, { error: "Invalid station credentials." });

  let input;
  try {
    input = await request.json();
  } catch {
    return jsonResponse(400, { error: "A JSON request body is required." });
  }

  const collectionId = String(input.collectionId || "").trim().slice(0, 80);
  const eventId = String(input.eventId || "").trim().slice(0, 100);
  const denomination = Number(input.denomination);
  const pulseCount = Number(input.pulseCount);
  if (!collectionId || !/^[a-zA-Z0-9:_-]+$/.test(eventId)) {
    return jsonResponse(400, { error: "collectionId and a valid unique eventId are required." });
  }
  if (!ACCEPTED_COIN_DENOMINATIONS.includes(denomination)) {
    return jsonResponse(400, { error: "Unsupported coin denomination." });
  }
  if (!Number.isInteger(pulseCount) || pulseCount < 1 || pulseCount > 100) {
    return jsonResponse(400, { error: "pulseCount must be an integer from 1 to 100." });
  }

  try {
    const now = Date.now();
    const result = await redis([
      "EVAL",
      ACCEPT_COIN_SCRIPT,
      2,
      coinCollectionKey(),
      coinEventKey(eventId),
      collectionId,
      denomination,
      now,
    ]);
    const status = Array.isArray(result) ? result[0] : null;
    const collection = publicCoinCollection(Array.isArray(result) ? result[1] : null);
    if (status === "accepted") {
      return jsonResponse(202, { accepted: true, duplicate: false, stationId: STATION_ID, collection });
    }
    if (status === "duplicate") {
      return jsonResponse(200, { accepted: true, duplicate: true, stationId: STATION_ID, collection });
    }
    if (status === "missing" || status === "expired") {
      return jsonResponse(410, { error: "Coin collection has expired." });
    }
    if (status === "mismatch") return jsonResponse(409, { error: "Coin event does not match the active collection." });
    return jsonResponse(409, { error: "Coin collection is no longer accepting coins." });
  } catch (error) {
    console.error("Unable to record CampusVolt coin", error);
    return jsonResponse(502, { error: "The coin event could not be recorded. The ESP32 should retry it." });
  }
}
