/**
 * CampusVolt - Kiosk Global Preferences Module
 * Manages linear font scaling, language, screen brightness, and sound alerts.
 * Persists preferences across all pages via localStorage.
 */

import { i18n } from "./i18n.js";
import { isDemoAuthorized } from "./demo-auth.js?v=1";

class KioskPreferences extends EventTarget {
  constructor() {
    super();
    this.fontScale = this._normalizeFontScale(localStorage.getItem("cv_font_scale"));
    this.brightness = localStorage.getItem("cv_brightness") || "auto";
    this.soundEnabled = localStorage.getItem("cv_sound") !== "false"; // default true
    this.lowBatteryAlert = localStorage.getItem("cv_low_battery") !== "false";
    this.demoModeEnabled = localStorage.getItem("cv_demo_mode") !== "false" && isDemoAuthorized();

    if (typeof window !== "undefined") {
      window.addEventListener("storage", (event) => {
        if (event.key === "cv_font_scale") {
          this.fontScale = this._normalizeFontScale(event.newValue);
          this.applyFontScale(this.fontScale);
          this.dispatchEvent(new CustomEvent("font-scale-changed", {
            detail: { percent: this.fontScale },
          }));
          return;
        }

        if (event.key === "cv_sound") {
          this.soundEnabled = event.newValue !== "false";
          this.dispatchEvent(new CustomEvent("sound-enabled-changed", {
            detail: { enabled: this.soundEnabled },
          }));
          return;
        }

        if (event.key === "cv_demo_mode") {
          this.demoModeEnabled = event.newValue !== "false" && isDemoAuthorized();
          this.applyDemoMode();
          this.dispatchEvent(new CustomEvent("demo-mode-changed", {
            detail: { enabled: this.demoModeEnabled },
          }));
        }
      });
    }
  }

  _normalizeFontScale(percent) {
    const parsed = Number.parseInt(percent ?? "100", 10);
    const safeValue = Number.isFinite(parsed) ? parsed : 100;
    return Math.max(85, Math.min(135, safeValue));
  }

  init() {
    this.applyFontScale(this.fontScale);
    this.applyBrightness(this.brightness);
    this.applyDemoMode();
    i18n.applyToDOM();
  }

  setFontScale(percent) {
    const val = this._normalizeFontScale(percent);
    this.fontScale = val;
    localStorage.setItem("cv_font_scale", val.toString());
    this.applyFontScale(val);
    this.dispatchEvent(new CustomEvent("font-scale-changed", {
      detail: { percent: val },
    }));
  }

  applyFontScale(percent) {
    const normalizedPercent = this._normalizeFontScale(percent);
    const scale = normalizedPercent / 100;
    document.documentElement.style.setProperty("--cv-font-scale", scale.toString());
    document.documentElement.style.fontSize = `${14 * scale}px`;

    const applyBodyZoom = () => {
      if (document.body) {
        // Mobile CSS previously forced zoom: 1 !important, silently disabling
        // the accessibility control. Use the same priority so the selected
        // scale wins on every viewport.
        document.body.style.setProperty("zoom", scale.toString(), "important");
        document.body.style.setProperty("--cv-font-scale", scale.toString());
      }
    };

    if (document.body) {
      applyBodyZoom();
    } else {
      document.addEventListener("DOMContentLoaded", applyBodyZoom, { once: true });
    }
  }

  setBrightness(mode) {
    this.brightness = mode;
    localStorage.setItem("cv_brightness", mode);
    this.applyBrightness(mode);
  }

  applyBrightness(mode) {
    const filter = mode === "60" ? "brightness(0.7)" : (mode === "100" ? "brightness(1.05)" : "none");
    document.documentElement.style.filter = filter;
  }

  setLanguage(lang) {
    i18n.setLanguage(lang);
  }

  getLanguage() {
    return i18n.getLanguage();
  }

  setSoundEnabled(enabled) {
    this.soundEnabled = Boolean(enabled);
    localStorage.setItem("cv_sound", String(this.soundEnabled));
    this.dispatchEvent(new CustomEvent("sound-enabled-changed", {
      detail: { enabled: this.soundEnabled },
    }));
  }

  isSoundEnabled() {
    return this.soundEnabled;
  }

  setDemoMode(enabled) {
    this.demoModeEnabled = Boolean(enabled) && isDemoAuthorized();
    localStorage.setItem("cv_demo_mode", String(this.demoModeEnabled));
    this.applyDemoMode();
    this.dispatchEvent(new CustomEvent("demo-mode-changed", {
      detail: { enabled: this.demoModeEnabled },
    }));
  }

  isDemoModeEnabled() {
    return this.demoModeEnabled;
  }

  applyDemoMode() {
    document.documentElement.dataset.demoMode = this.demoModeEnabled ? "on" : "off";
  }
}

export const kioskPreferences = new KioskPreferences();

// Auto-apply preferences immediately when DOM is loaded
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => kioskPreferences.init());
  } else {
    kioskPreferences.init();
  }
}
