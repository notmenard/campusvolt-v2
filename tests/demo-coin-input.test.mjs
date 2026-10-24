import assert from "node:assert/strict";
import test from "node:test";

class TestCustomEvent extends Event {
  constructor(type, options = {}) {
    super(type);
    this.detail = options.detail;
  }
}

const storage = new Map();
const testWindow = new EventTarget();
globalThis.window = testWindow;
globalThis.CustomEvent = TestCustomEvent;
globalThis.BroadcastChannel = undefined;
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

const { demoCoinInput } = await import("../js/modules/demo-coin-input.js?v=2-test");

test("demo coins can be reduced without going below zero", () => {
  demoCoinInput.reset("outlet-1");
  assert.equal(demoCoinInput.addCoin("outlet-1", 20).total, 20);
  assert.equal(demoCoinInput.removeCoin("outlet-1", 5).total, 15);
  assert.equal(demoCoinInput.removeCoin("outlet-1", 20).total, 0);
});

test("invalid removal amounts do not change the demo balance", () => {
  demoCoinInput.reset("outlet-2");
  demoCoinInput.addCoin("outlet-2", 10);
  assert.equal(demoCoinInput.removeCoin("outlet-2", 0).total, 10);
  assert.equal(demoCoinInput.removeCoin("outlet-2", -5).total, 10);
  assert.equal(demoCoinInput.removeCoin("not-a-port", 5).total, 10);
});
