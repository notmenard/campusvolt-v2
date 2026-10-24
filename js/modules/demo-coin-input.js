const STORAGE_KEY = "cv_demo_coin_input";
const CHANNEL_NAME = "campusvolt_demo_coin_input";
const MAX_DEMO_AMOUNT = 120;
const DEFAULT_STATE = Object.freeze({
  portId: "outlet-1",
  total: 0,
  updatedAt: 0,
});

const VALID_PORT_IDS = new Set([
  "outlet-1",
  "outlet-2",
  "dc-type-c",
  "dc-micro-usb",
  "dc-lightning",
  "wireless-pad",
]);

function normalizeState(value) {
  const portId = VALID_PORT_IDS.has(value?.portId) ? value.portId : DEFAULT_STATE.portId;
  const total = Math.min(MAX_DEMO_AMOUNT, Math.max(0, Math.round(Number(value?.total) || 0)));
  const updatedAt = Math.max(0, Number(value?.updatedAt) || 0);
  return { portId, total, updatedAt };
}

class DemoCoinInput extends EventTarget {
  constructor() {
    super();
    this.state = this._load();
    this.channel = null;

    if (typeof BroadcastChannel !== "undefined") {
      try {
        this.channel = new BroadcastChannel(CHANNEL_NAME);
        this.channel.addEventListener("message", (event) => this._acceptExternalState(event.data));
      } catch (error) {
        this.channel = null;
      }
    }

    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try {
        this._acceptExternalState(JSON.parse(event.newValue));
      } catch (error) {
        // Ignore malformed demo data from another tab.
      }
    });
  }

  getState() {
    return { ...this.state };
  }

  selectPort(portId) {
    if (!VALID_PORT_IDS.has(portId) || portId === this.state.portId) return this.getState();
    return this._save({ portId, total: 0, updatedAt: Date.now() });
  }

  addCoin(portId, denomination) {
    if (!VALID_PORT_IDS.has(portId)) return this.getState();
    const coin = Math.round(Number(denomination));
    if (!Number.isFinite(coin) || coin <= 0) return this.getState();
    const currentTotal = this.state.portId === portId ? this.state.total : 0;
    return this._save({
      portId,
      total: Math.min(MAX_DEMO_AMOUNT, currentTotal + coin),
      updatedAt: Date.now(),
    });
  }

  reset(portId = this.state.portId) {
    const safePortId = VALID_PORT_IDS.has(portId) ? portId : DEFAULT_STATE.portId;
    return this._save({ portId: safePortId, total: 0, updatedAt: Date.now() });
  }

  _load() {
    try {
      return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"));
    } catch (error) {
      return { ...DEFAULT_STATE };
    }
  }

  _save(nextState) {
    this.state = normalizeState(nextState);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    this.channel?.postMessage(this.state);
    this._emit();
    return this.getState();
  }

  _acceptExternalState(nextState) {
    const normalized = normalizeState(nextState);
    if (
      normalized.portId === this.state.portId
      && normalized.total === this.state.total
      && normalized.updatedAt === this.state.updatedAt
    ) return;
    this.state = normalized;
    this._emit();
  }

  _emit() {
    const detail = { ...this.state, source: "demo" };
    this.dispatchEvent(new CustomEvent("coin-input-changed", { detail }));
    window.dispatchEvent(new CustomEvent("campusvolt:coin-input", { detail }));
  }
}

export const demoCoinInput = new DemoCoinInput();
