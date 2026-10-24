import assert from "node:assert/strict";
import test from "node:test";

process.env.CAMPUSVOLT_STATION_API_KEY = "test-key-with-at-least-32-characters";
process.env.CAMPUSVOLT_STATION_ID = "station-01";
process.env.UPSTASH_REDIS_REST_URL = "https://redis.example.test";
process.env.UPSTASH_REDIS_REST_TOKEN = "test-redis-token";

let redisCommands = [];
let mockSessions = [];
globalThis.fetch = async (_url, options) => {
  const command = JSON.parse(options.body);
  redisCommands.push(command);
  if (command[0] === "MGET") {
    return Response.json({ result: [
      ...channelIds.map((portId) => {
        const session = mockSessions.find((item) => item.portId === portId);
        return session ? JSON.stringify(session) : null;
      }),
      null,
    ] });
  }
  return Response.json({ result: "OK" });
};

const { POST } = await import("../api/station-status.mjs");

const channelIds = [
  "outlet-1",
  "outlet-2",
  "dc-type-c",
  "dc-micro-usb",
  "dc-lightning",
  "wireless-pad",
];

function payload() {
  return {
    schemaVersion: 1,
    stationId: "station-01",
    messageId: "station-01-test-1",
    sentAt: Date.now() - 25,
    firmwareVersion: "test-1.0.0",
    rssi: -55,
    channels: Object.fromEntries(channelIds.map((portId) => [portId, {
      inUse: portId === "outlet-1",
      watts: portId === "outlet-1" ? 42 : 0,
      voltageV: portId.startsWith("outlet-") ? 220 : 5.1,
      currentA: portId === "outlet-1" ? 0.19 : 0,
      relayOn: true,
      fault: null,
    }])),
    telemetry: {
      battery: {
        connected: true,
        soc: 82.5,
        voltageV: 13.31,
        currentA: 8.4,
        powerW: 111.8,
        temperatureC: 31.2,
        protection: "normal",
        status: "charging",
        ratedCapacityAh: 100,
        ratedEnergyWh: 1280,
        remainingAh: 82.5,
        remainingEnergyWh: 1056,
        healthPercent: 98,
        cycleCount: 42,
        cellMinVoltageV: 3.31,
        cellMaxVoltageV: 3.34,
        cellDeltaMv: 30,
      },
      solar: {
        powerW: 285,
        energyTodayWh: 1800,
        peakPowerW: 450,
        panelVoltageV: 18.6,
        controllerState: "charging",
      },
    },
  };
}

function request(body, key = process.env.CAMPUSVOLT_STATION_API_KEY) {
  return new Request("https://campusvolt.example/api/station-status", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("rejects an invalid station credential", async () => {
  const response = await POST(request(payload(), "wrong-key"));
  assert.equal(response.status, 401);
});

test("requires a complete six-channel snapshot", async () => {
  const body = payload();
  delete body.channels["wireless-pad"];
  const response = await POST(request(body));
  const result = await response.json();
  assert.equal(response.status, 400);
  assert.match(result.error, /wireless-pad is required/);
});

test("rejects out-of-range sensor values instead of silently clamping", async () => {
  const body = payload();
  body.telemetry.battery.soc = 140;
  const response = await POST(request(body));
  const result = await response.json();
  assert.equal(response.status, 400);
  assert.match(result.error, /telemetry\.battery\.soc/);
});

test("accepts and stores a complete physical telemetry heartbeat", async () => {
  redisCommands = [];
  mockSessions = [];
  const response = await POST(request(payload()));
  const result = await response.json();
  assert.equal(response.status, 202);
  assert.equal(result.accepted, true);
  assert.equal(result.station.online, true);
  assert.equal(result.station.telemetry.battery.soc, 82.5);
  assert.equal(result.station.telemetry.solar.powerW, 285);
  const setCommand = redisCommands.find((command) => command[0] === "SET");
  assert.equal(setCommand[0], "SET");
  assert.equal(setCommand.at(-2), "EX");
  assert.equal(setCommand.at(-1), 30);
  assert.equal(result.control.channels["outlet-1"].relayOn, false);
  assert.equal(result.control.commandId, "relay:all-off");

  const stored = JSON.parse(setCommand[2]);
  assert.equal(stored.messageId, "station-01-test-1");
  assert.equal(stored.channels["outlet-1"].inUse, true);
  assert.equal(stored.telemetry.battery.protection, "normal");
});

test("returns a leased relay-on command only for a paid active session", async () => {
  const now = Date.now();
  mockSessions = [{ portId: "outlet-2", endTime: now + 60_000 }];
  const response = await POST(request(payload()));
  const result = await response.json();

  assert.equal(response.status, 202);
  assert.equal(result.control.channels["outlet-2"].relayOn, true);
  assert.equal(result.control.channels["outlet-1"].relayOn, false);
  assert.ok(result.control.validUntil > result.control.issuedAt);
  assert.ok(result.control.validUntil - result.control.issuedAt <= 15_000);
  assert.ok(result.control.channels["outlet-2"].authorizedUntil <= now + 60_000);
  assert.match(result.control.commandId, /^relay:outlet-2@/);
  mockSessions = [];
});

test("keeps channel-only heartbeats available for staged bring-up", async () => {
  const body = payload();
  delete body.telemetry;
  const response = await POST(request(body));
  const result = await response.json();
  assert.equal(response.status, 202);
  assert.equal(result.station.telemetry, null);
});
