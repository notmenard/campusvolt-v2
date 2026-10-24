import { kioskPreferences } from "./kiosk-preferences.js?v=4";

const SOUND_URLS = Object.freeze({
  connected: new URL("../../audio/connected.mp3", import.meta.url).href,
  disconnected: new URL("../../audio/disconnected.mp3", import.meta.url).href,
  normal: new URL("../../audio/normal.mp3", import.meta.url).href,
  conservation: new URL("../../audio/conservation.mp3", import.meta.url).href,
  survival: new URL("../../audio/cutoff.mp3", import.meta.url).href,
  cutoff: new URL("../../audio/survival.mp3", import.meta.url).href,
});

const DEDUPE_WINDOW_MS = 1_500;
const DEDUPE_PREFIX = "cv_sound_alert_";

export function getEnergyAlertName(snapshot) {
  const policy = snapshot?.energyManagement;
  if (!policy) return null;

  if (Number(policy.maxLoadW) <= 0 || policy.safetyState === "battery-cutoff") {
    return "cutoff";
  }
  if (policy.mode === "survival-eco-mode") return "survival";
  if (policy.mode === "conservation-mode") return "conservation";
  if (policy.mode === "normal-mode") return "normal";
  return null;
}

class SoundAlerts {
  constructor() {
    this.audio = null;
    this.pendingName = null;
    this.userInteracted = false;

    if (typeof document !== "undefined") {
      this._handleUserGesture = () => this._unlockFromUserGesture();
      document.addEventListener("pointerdown", this._handleUserGesture, { capture: true, passive: true });
      document.addEventListener("touchstart", this._handleUserGesture, { capture: true, passive: true });
      document.addEventListener("keydown", this._handleUserGesture, { capture: true });
    }

    kioskPreferences.addEventListener("sound-enabled-changed", (event) => {
      if (!event.detail.enabled) this.stop();
    });
  }

  _ensureAudio() {
    if (this.audio || typeof Audio === "undefined") return this.audio;
    this.audio = new Audio();
    this.audio.preload = "auto";
    return this.audio;
  }

  _unlockFromUserGesture() {
    if (this.userInteracted || !kioskPreferences.isSoundEnabled()) return;
    this.userInteracted = true;

    const pendingName = this.pendingName;
    this.pendingName = null;
    if (pendingName) {
      this.play(pendingName, { skipDedupe: true });
      return;
    }

    // Prime one reusable audio element while the browser has a user gesture.
    const audio = this._ensureAudio();
    if (!audio) return;
    audio.muted = true;
    audio.src = SOUND_URLS.connected;
    const playResult = audio.play();
    if (playResult?.then) {
      playResult.then(() => {
        audio.pause();
        audio.currentTime = 0;
        audio.muted = false;
      }).catch(() => {
        audio.muted = false;
      });
    } else {
      audio.pause();
      audio.currentTime = 0;
      audio.muted = false;
    }
  }

  _claim(name) {
    const key = `${DEDUPE_PREFIX}${name}`;
    const now = Date.now();
    try {
      const previous = Number(localStorage.getItem(key)) || 0;
      if (now - previous < DEDUPE_WINDOW_MS) return false;
      localStorage.setItem(key, String(now));
    } catch {
      // Sound still works when storage is unavailable.
    }
    return true;
  }

  async play(name, { skipDedupe = false } = {}) {
    if (!SOUND_URLS[name] || !kioskPreferences.isSoundEnabled()) return false;
    if (!skipDedupe && !this._claim(name)) return false;

    const audio = this._ensureAudio();
    if (!audio) return false;

    audio.pause();
    audio.muted = false;
    audio.currentTime = 0;
    audio.src = SOUND_URLS[name];

    try {
      await audio.play();
      this.pendingName = null;
      return true;
    } catch (error) {
      // Browsers may block programmatic mode alerts until the first tap.
      if (error?.name === "NotAllowedError") this.pendingName = name;
      else console.warn(`CampusVolt: Unable to play ${name} alert.`, error);
      return false;
    }
  }

  stop() {
    this.pendingName = null;
    if (!this.audio) return;
    this.audio.pause();
    this.audio.currentTime = 0;
  }
}

export const soundAlerts = new SoundAlerts();
