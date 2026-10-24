import assert from "node:assert/strict";
import test, { after } from "node:test";

class TestCustomEvent extends Event {
  constructor(type, options = {}) {
    super(type);
    this.detail = options.detail;
  }
}

const storage = new Map();
globalThis.CustomEvent = TestCustomEvent;
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

const { portsState } = await import("../js/modules/ports-state.js");
const { telemetryStore } = await import("../js/modules/telemetry-store.js?v=6");

after(() => telemetryStore.channel?.close());

const channels = {
  "outlet-1": { inUse: true, watts: 42, voltageV: 220, currentA: 0.19, relayOn: true, fault: null },
  "outlet-2": { inUse: false, watts: 0, voltageV: 220, currentA: 0, relayOn: true, fault: null },
  "dc-type-c": { inUse: true, watts: 9, voltageV: 5.1, currentA: 1.76, relayOn: true, fault: null },
  "dc-micro-usb": { inUse: false, watts: 0, voltageV: 5.1, currentA: 0, relayOn: true, fault: null },
  "dc-lightning": { inUse: false, watts: 0, voltageV: 5.1, currentA: 0, relayOn: true, fault: null },
  "wireless-pad": { inUse: false, watts: 0, voltageV: 5.1, currentA: 0, relayOn: true, fault: null },
};

test("physical heartbeat replaces simulated telemetry and expires safely", () => {
  const now = Date.now();
  portsState._applyHardwareState({
    online: true,
    schemaVersion: 1,
    stationId: "station-01",
    messageId: "station-01-test-telemetry",
    sentAt: now - 40,
    updatedAt: now,
    latencyMs: 40,
    firmwareVersion: "test-1.0.0",
    rssi: -55,
    channels,
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
        remainingEnergyWh: 1056,
      },
      solar: {
        powerW: 285,
        energyTodayWh: 1800,
        peakPowerW: 450,
        panelVoltageV: 18.6,
        controllerState: "charging",
      },
    },
  });

  const live = telemetryStore.getSnapshot();
  assert.equal(live.source, "station-hardware");
  assert.equal(live.battery.soc, 82.5);
  assert.equal(live.solar.powerW, 285);
  assert.equal(live.load.totalPowerW, 51);
  assert.equal(live.load.activePorts, 2);
  assert.equal(live.system.bmsConnected, true);
  assert.equal(live.system.messageId, "station-01-test-telemetry");

  portsState._applyHardwareState({ online: false, stationId: "station-01", channels: {} });
  const expired = telemetryStore.getSnapshot();
  assert.equal(expired.system.connected, false);
  assert.equal(expired.system.bmsConnected, false);
  assert.equal(expired.energyManagement.maxLoadW, 0);
  assert.equal(expired.energyManagement.safetyState, "monitoring-unavailable");
});
