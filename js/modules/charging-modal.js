/**
 * CampusVolt Dashboard - Charging Modal Module
 * Matches Figma specifications:
 * 1. 4-step sequence: (1) Pay — (2) Confirm — (3) Connect — (4) Charging [X]
 * 2. Select Payment Method (Cash / GCash cards)
 * 3. Sub-steps with "< Back" button for inserting coins / scanning QR
 * 4. In-use port overlay with 15:00 countdown, linear progress bar, 2x2 session telemetry, and Done button.
 * 5. Full bilingual translation (English / Filipino).
 */

import { PRICING_CONFIG } from "./ports-config.js";
import { i18n } from "./i18n.js";
import { demoCoinInput } from "./demo-coin-input.js?v=2";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}

export class ChargingModal {
  constructor(state) {
    this.state = state;
    this.dialog = null;
    this.currentPort = null;
    this.selectedMethod = "Cash"; // "Cash" | "GCash"
    this.selectedDuration = 15; // default 15 mins (₱15)
    this.insertedCoins = 0;
    this.coinTarget = 15;
    this.coinCollection = null;
    this.coinPollTimer = null;
    this.activeStep = "pay-select"; // "pay-select" | "pay-cash" | "pay-gcash" | "confirm" | "connect" | "charging"
    this.activeSession = null;

    this._ensureDialogElement();
    this._bindGlobalEvents();
  }

  _ensureDialogElement() {
    let dialog = document.getElementById("charging-modal");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "charging-modal";
      dialog.className = "charging-modal";
      dialog.setAttribute("aria-modal", "true");
      document.body.appendChild(dialog);
    }
    this.dialog = dialog;

    // Close on backdrop click (only when directly clicking on the dialog backdrop outside modal-card)
    this.dialog.addEventListener("click", (e) => {
      if (e.target === this.dialog) {
        this.close();
      }
    });

    // Close on ESC key
    this.dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      this.close();
    });
  }

  _bindGlobalEvents() {
    this.state.addEventListener("session-tick", (e) => {
      const session = e.detail.session;
      if (this.currentPort && session.portId === this.currentPort.id && this.activeStep === "charging") {
        this._updateActiveTimerView(session);
      }
    });

    this.state.addEventListener("session-completed", (e) => {
      const { port, session } = e.detail;
      if (this.currentPort && port.id === this.currentPort.id && this.activeStep === "charging") {
        this.close();
      }
    });

    // Hardware adapters can report accepted coins without coupling their
    // transport logic to this modal. Send detail.amount for a denomination or
    // detail.total for the coin acceptor's authoritative running total.
    window.addEventListener("campusvolt:coin-input", (event) => {
      if (this.activeStep !== "pay-cash" || !this.currentPort || !this.coinCollection) return;
      const detail = event.detail || {};
      if (detail.portId && detail.portId !== this.currentPort.id) return;

      if (detail.total !== undefined && detail.total !== null && Number.isFinite(Number(detail.total))) {
        this._setInsertedCoins(Number(detail.total));
      } else {
        const denomination = Number(detail.amount);
        if (Number.isFinite(denomination) && denomination > 0) {
          this._setInsertedCoins(this.insertedCoins + denomination);
        }
      }
    });

    i18n.addEventListener("language-changed", () => {
      if (this.dialog && this.dialog.open && this.currentPort) {
        this._renderCurrentStep();
      }
    });
  }

  /**
   * Open modal for a specific port
   */
  openForPort(portId) {
    const port = this.state.getPort(portId);
    if (!port) return;

    this.currentPort = port;
    const existingSession = this.state.getSession(portId);
    const hardwareChannel = this.state.getHardwareChannel(portId);

    if (hardwareChannel?.fault && !existingSession) {
      this.activeSession = null;
      this.showHardwareOccupiedStep(hardwareChannel);
    } else if (port.status === "in-use" || existingSession) {
      // In-use port clicked: open overlay directly matching Screenshot 3!
      this.activeSession = existingSession || {
        portId: port.id,
        portName: port.name,
        device: "Phone",
        watts: 9,
        paid: "₱15 · Cash",
        durationMinutes: 15,
        totalSeconds: 900,
        remainingSeconds: 900,
      };
      this.showChargingStep(this.activeSession);
    } else {
      // Available port clicked: open Step 1 (Select Payment Method) matching Screenshot 1!
      this.selectedMethod = "Cash";
      this.selectedDuration = 15;
      this.insertedCoins = 0;
      this.coinTarget = 15;
      this.coinCollection = null;
      this.showPaySelectStep();
    }

    if (!this.dialog.open) {
      this.dialog.showModal();
    }
  }

  showHardwareOccupiedStep(channel) {
    this.activeStep = "hardware-occupied";
    const port = this.currentPort;
    const station = this.state.getHardwareStatus();
    const t = (key) => i18n.t(key);
    const updatedTime = station.updatedAt
      ? new Date(station.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : "--";
    const hardwareTitle = channel.fault ? t("hardware_fault_title") : t("hardware_occupied_title");
    const hardwareDescription = channel.fault
      ? `${t("hardware_fault_desc")} ${escapeHtml(channel.fault)}`
      : t("hardware_occupied_desc");

    this.dialog.innerHTML = `
      <div class="modal-card">
        ${this._renderStepsHeader(4)}
        <div class="modal-body modal-body--charging">
          <div class="port-title-row">
            <h2 class="modal-port-name">${port.name}</h2>
            <span class="port-status-pill port-status-pill--in-use">${t("status_in_use")}</span>
          </div>

          <div class="charging-timer-display">
            <span class="charging-timer-val charging-timer-val--hardware">${hardwareTitle}</span>
            <span class="charging-timer-sub">${hardwareDescription}</span>
          </div>

          <div class="charging-stats-2x2">
            <div class="charging-stat-box">
              <span class="charging-stat-label">${t("active_power_draw")}</span>
              <strong class="charging-stat-val">${Number(channel.watts || 0).toFixed(1)} W</strong>
            </div>
            <div class="charging-stat-box">
              <span class="charging-stat-label">${t("hardware_voltage")}</span>
              <strong class="charging-stat-val">${Number(channel.voltageV || 0).toFixed(1)} V</strong>
            </div>
            <div class="charging-stat-box">
              <span class="charging-stat-label">${t("hardware_current")}</span>
              <strong class="charging-stat-val">${Number(channel.currentA || 0).toFixed(2)} A</strong>
            </div>
            <div class="charging-stat-box">
              <span class="charging-stat-label">${t("hardware_last_seen")}</span>
              <strong class="charging-stat-val">${updatedTime}</strong>
            </div>
          </div>

          <button type="button" class="btn--done" id="charging-done-btn">${t("active_btn_done")}</button>
          <p class="charging-footer-note">${t("hardware_occupied_footer")}</p>
        </div>
      </div>
    `;

    this.dialog.querySelector("#modal-close-btn")?.addEventListener("click", () => this.close());
    this.dialog.querySelector("#charging-done-btn")?.addEventListener("click", () => this.close());
  }

  close() {
    if (this.coinCollection?.collectionId && this.insertedCoins > 0 && this.activeStep !== "charging") {
      if (this.cashDisplayElements?.statusTextEl?.isConnected) {
        this.cashDisplayElements.statusTextEl.textContent = "Inserted physical coins cannot be cancelled. Complete this payment.";
      }
      return;
    }
    this._stopCoinPolling();
    this._cancelEmptyCoinCollection();
    if (this.dialog && this.dialog.open) {
      this.dialog.close();
    }
  }

  /**
   * Render top 4-step progress header:
   * (1) Pay — (2) Confirm — (3) Connect — (4) Charging [X]
   */
  _renderStepsHeader(activeStepNumber) {
    const t = (k) => i18n.t(k);
    const steps = [
      { num: 1, label: t("step_pay") },
      { num: 2, label: t("step_confirm") },
      { num: 3, label: t("step_connect") },
      { num: 4, label: t("step_charging") },
    ];

    return `
      <header class="modal-steps-header">
        <div class="modal-steps-list" role="progressbar" aria-valuenow="${activeStepNumber}" aria-valuemin="1" aria-valuemax="4">
          ${steps.map((s, idx) => {
            const isActive = s.num === activeStepNumber;
            const isCompleted = s.num < activeStepNumber;
            let statusClass = "modal-step--pending";
            if (isActive) statusClass = "modal-step--active";
            else if (isCompleted) statusClass = "modal-step--completed";

            return `
              <div class="modal-step ${statusClass}">
                <span class="step-num">${s.num}</span>
                <span class="step-text">${s.label}</span>
              </div>
              ${idx < steps.length - 1 ? `<span class="step-divider" aria-hidden="true">—</span>` : ""}
            `;
          }).join("")}
        </div>
        <button type="button" class="modal-close-icon-btn" id="modal-close-btn" aria-label="Close dialog">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </header>
    `;
  }

  /**
   * STEP 1: Select Payment Method (Figma Main Design)
   */
  showPaySelectStep() {
    this.activeStep = "pay-select";
    const port = this.currentPort;
    const t = (k) => i18n.t(k);

    this.dialog.innerHTML = `
      <div class="modal-card">
        ${this._renderStepsHeader(1)}

        <div class="modal-body modal-body--pay-select">
          <div class="port-title-row">
            <h2 class="modal-port-name">${port.name}</h2>
            <span class="port-status-pill port-status-pill--available">${t("status_available")}</span>
          </div>

          <p class="modal-instructions">
            ${t("modal_choose_pay")} <strong>${t("modal_rate_notice")}</strong>
          </p>

          <div class="payment-methods-grid" role="group" aria-label="Select payment method">
            <!-- Cash Option -->
            <button type="button" class="payment-method-card" id="btn-select-cash" data-method="Cash">
              <div class="payment-method-icon payment-method-icon--cash" aria-hidden="true">
                <img class="payment-method-image payment-method-image--cash" src="../images/payment-cash-campusvolt.png?v=1" alt="">
              </div>
              <h3 class="payment-method-title">${t("modal_cash_title")}</h3>
              <p class="payment-method-sub">${t("modal_cash_sub")}</p>
            </button>

            <!-- GCash Option -->
            <button type="button" class="payment-method-card" id="btn-select-gcash" data-method="GCash">
              <div class="payment-method-icon payment-method-icon--gcash" aria-hidden="true">
                <img class="payment-method-image payment-method-image--gcash" src="../images/payment-gcash-campusvolt.png?v=1" alt="">
              </div>
              <h3 class="payment-method-title">${t("modal_gcash_title")}</h3>
              <p class="payment-method-sub">${t("modal_gcash_sub")}</p>
            </button>
          </div>

          <p class="modal-footer-caption">
            ${t("modal_footer_caption")}
          </p>
        </div>
      </div>
    `;

    this.dialog.querySelector("#modal-close-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.close();
    });

    this.dialog.querySelector("#btn-select-cash")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.selectedMethod = "Cash";
      this.showPayCashStep();
    });

    this.dialog.querySelector("#btn-select-gcash")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.selectedMethod = "GCash";
      this.showPayGCashStep();
    });
  }

  /**
   * STEP 1.1: Cash Flow - physical coin input with "< Back" button
   */
  showPayCashStep() {
    this.activeStep = "pay-cash";
    const port = this.currentPort;
    const t = (k) => i18n.t(k);
    const isDemo = document.documentElement.dataset.demoMode === "on";
    const demoCoins = demoCoinInput.getState();
    if (isDemo && demoCoins.portId === port.id) {
      this.insertedCoins = demoCoins.total;
    }
    const collectionActive = Boolean(this.coinCollection);

    this.dialog.innerHTML = `
      <div class="modal-card">
        ${this._renderStepsHeader(1)}

        <div class="modal-body modal-body--cash">
          <button type="button" class="modal-back-btn" id="modal-back-btn" aria-label="Go back to payment selection">
            ${t("btn_back")}
          </button>

          <div class="cash-title-row">
            <h2 class="modal-section-title">${t("cash_insert_title")}</h2>
            <span class="port-status-pill port-status-pill--available">${escapeHtml(port.name)}</span>
          </div>
          <p class="modal-instructions">${t("cash_insert_desc")}</p>

          <div class="coins-simulator-box cash-target-panel">
            <div class="coin-display-balance">
              <span class="coin-balance-label">Charging time / coin target</span>
              <span class="coin-balance-val" id="cash-target-value">₱${this.coinTarget}</span>
              <span class="coin-minutes-val">${this.coinTarget} minutes</span>
            </div>
            <input type="range" id="cash-target-slider" class="modal-linear-slider"
              min="1" max="120" step="1" value="${this.coinTarget}"
              ${collectionActive ? "disabled" : ""} aria-label="Cash amount and charging minutes">
            ${collectionActive ? "" : `<button type="button" class="btn btn--primary btn--full" id="begin-coin-collection-btn">Start accepting coins</button>`}
          </div>

          <div class="cash-insert-panel" ${collectionActive || isDemo ? "" : "hidden"}>
            <div class="cash-slot" aria-hidden="true">
              <span class="cash-slot__opening"></span>
            </div>

            <div class="coin-display-balance">
              <span class="coin-balance-label">${t("cash_total_label")}</span>
              <span class="coin-balance-val" id="coin-balance-val" aria-live="polite">₱${this.insertedCoins}</span>
            </div>

            <div class="cash-input-status" id="cash-input-status" role="status">
              <span class="cash-input-status__dot" aria-hidden="true"></span>
              <span id="cash-input-status-text">${this.insertedCoins >= this.coinTarget ? "Target reached" : t("cash_waiting_status")}</span>
            </div>

            <div class="cash-demo-controls" role="group" aria-label="${t("cash_demo_label")}">
              <span class="cash-demo-controls__label">${t("cash_demo_label")}</span>
              <button type="button" class="coin-btn" data-add-coin="1">+ ₱1</button>
              <button type="button" class="coin-btn" data-add-coin="5">+ ₱5</button>
              <button type="button" class="coin-btn coin-btn--recommended" data-add-coin="10">+ ₱10</button>
              <button type="button" class="coin-btn" data-add-coin="20">+ ₱20</button>
              <span class="cash-demo-controls__label cash-demo-controls__label--remove">${t("cash_demo_remove_label")}</span>
              <button type="button" class="coin-btn coin-btn--remove" data-remove-coin="1">− ₱1</button>
              <button type="button" class="coin-btn coin-btn--remove" data-remove-coin="5">− ₱5</button>
              <button type="button" class="coin-btn coin-btn--remove" data-remove-coin="10">− ₱10</button>
              <button type="button" class="coin-btn coin-btn--remove" data-remove-coin="20">− ₱20</button>
            </div>
          </div>

          <button type="button" class="btn btn--primary btn--full cash-confirm-btn" id="confirm-coins-btn" ${this.insertedCoins >= this.coinTarget ? "" : "hidden disabled"}>
            ${t("cash_proceed_btn")} (₱${this.insertedCoins})
          </button>

          <p class="cash-rate-note">${t("cash_rate_note")}</p>
        </div>
      </div>
    `;

    this.dialog.querySelector("#modal-close-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.close();
    });
    this.dialog.querySelector("#modal-back-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.insertedCoins > 0 && this.coinCollection) {
        if (this.cashDisplayElements?.statusTextEl) {
          this.cashDisplayElements.statusTextEl.textContent = "Inserted physical coins cannot be cancelled. Complete this payment.";
        }
        return;
      }
      this._stopCoinPolling();
      this._cancelEmptyCoinCollection();
      this.showPaySelectStep();
    });

    this.cashDisplayElements = {
      balEl: this.dialog.querySelector("#coin-balance-val"),
      statusEl: this.dialog.querySelector("#cash-input-status"),
      statusTextEl: this.dialog.querySelector("#cash-input-status-text"),
      procBtn: this.dialog.querySelector("#confirm-coins-btn"),
    };
    this._updateCashDisplays();

    this.dialog.querySelector("#cash-target-slider")?.addEventListener("input", (event) => {
      this.coinTarget = Math.max(1, Math.min(120, Number(event.target.value) || 1));
      this.selectedDuration = this.coinTarget;
      this.showPayCashStep();
    });
    this.dialog.querySelector("#begin-coin-collection-btn")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = "Reserving coin acceptor...";
      try {
        if (isDemo) {
          this.coinCollection = { collectionId: null, portId: port.id, targetAmount: this.coinTarget, status: "collecting" };
        } else {
          const response = await fetch("/api/coin-collections", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ portId: port.id, targetAmount: this.coinTarget }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload.error || "Unable to reserve the coin acceptor.");
          this.coinCollection = payload.collection;
          this.insertedCoins = Number(payload.collection.insertedAmount) || 0;
          this._startCoinPolling();
        }
        this.showPayCashStep();
      } catch (error) {
        button.disabled = false;
        button.textContent = error.message || "Unable to start coin collection";
      }
    });

    this.dialog.querySelectorAll("[data-add-coin]").forEach(btn => {
      btn.addEventListener("click", () => {
        const val = parseInt(btn.dataset.addCoin, 10);
        demoCoinInput.addCoin(this.currentPort?.id, val);
      });
    });

    this.dialog.querySelectorAll("[data-remove-coin]").forEach(btn => {
      btn.addEventListener("click", () => {
        const val = parseInt(btn.dataset.removeCoin, 10);
        demoCoinInput.removeCoin(this.currentPort?.id, val);
      });
    });

    this.dialog.querySelector("#confirm-coins-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.insertedCoins < this.coinTarget) return;
      this.selectedMethod = "Cash";
      this.selectedDuration = this.coinCollection?.targetAmount || this.coinTarget;
      this._stopCoinPolling();
      this.showConfirmStep();
    });
  }

  _setInsertedCoins(value) {
    const nextAmount = Math.round(Number(value));
    if (!Number.isFinite(nextAmount) || nextAmount < 0) return;
    this.insertedCoins = Math.min(PRICING_CONFIG.maxDuration, nextAmount);
    this._updateCashDisplays();
  }

  _updateCashDisplays() {
    const elements = this.cashDisplayElements;
    if (!elements) return;
    const hasCoins = this.insertedCoins > 0;
    const targetReached = this.insertedCoins >= this.coinTarget;
    const t = (key) => i18n.t(key);

    if (elements.balEl) elements.balEl.textContent = `₱${this.insertedCoins}`;
    if (elements.statusTextEl) {
      elements.statusTextEl.textContent = targetReached
        ? "Target reached — continue to confirmation"
        : (hasCoins ? `Received ₱${this.insertedCoins}; ₱${this.coinTarget - this.insertedCoins} remaining` : t("cash_waiting_status"));
    }
    elements.statusEl?.classList.toggle("cash-input-status--received", hasCoins);
    this.dialog.querySelectorAll("[data-remove-coin]").forEach((button) => {
      button.disabled = !hasCoins;
    });
    if (elements.procBtn) {
      elements.procBtn.textContent = `${t("cash_proceed_btn")} (₱${this.insertedCoins})`;
      elements.procBtn.hidden = !targetReached;
      elements.procBtn.disabled = !targetReached;
    }
  }

  _startCoinPolling() {
    this._stopCoinPolling();
    const collectionId = this.coinCollection?.collectionId;
    if (!collectionId) return;
    const poll = async () => {
      try {
        const response = await fetch(`/api/coin-collections?collectionId=${encodeURIComponent(collectionId)}`, { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "Coin collection unavailable.");
        this.coinCollection = payload.collection;
        this._setInsertedCoins(payload.collection.insertedAmount);
        if (payload.collection.status === "ready") this._stopCoinPolling();
      } catch (error) {
        if (this.cashDisplayElements?.statusTextEl) this.cashDisplayElements.statusTextEl.textContent = error.message;
      }
    };
    poll();
    this.coinPollTimer = setInterval(poll, 1000);
  }

  _stopCoinPolling() {
    if (this.coinPollTimer) clearInterval(this.coinPollTimer);
    this.coinPollTimer = null;
  }

  _cancelEmptyCoinCollection() {
    const collection = this.coinCollection;
    if (!collection?.collectionId || Number(collection.insertedAmount) > 0) return;
    this.coinCollection = null;
    fetch("/api/coin-collections", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collectionId: collection.collectionId }),
      keepalive: true,
    }).catch(() => {});
  }

  /**
   * STEP 1.2: GCash Flow - Aligned with Cash UI Design + QR code
   */
  showPayGCashStep() {
    this.activeStep = "pay-gcash";
    const port = this.currentPort;
    const t = (k) => i18n.t(k);

    this.dialog.innerHTML = `
      <div class="modal-card">
        ${this._renderStepsHeader(1)}

        <div class="modal-body modal-body--gcash">
          <button type="button" class="modal-back-btn" id="modal-back-btn" aria-label="Go back to payment selection">
            ${t("btn_back")}
          </button>

          <h2 class="modal-section-title">${t("gcash_qr_title")}</h2>
          <p class="modal-instructions">${t("gcash_qr_desc")}</p>

          <!-- Price & Time Selector Box (Formatted identically to Cash UI) -->
          <div class="coins-simulator-box" style="margin-bottom: 14px;">
            <div class="coin-display-balance">
              <span class="coin-balance-label">${t("gcash_total_label")}</span>
              <span class="coin-balance-val" id="gcash-balance-val">₱${this.selectedDuration}</span>
              <span class="coin-minutes-val" id="gcash-minutes-val">${this.selectedDuration} ${t("cash_mins_suffix")}</span>
            </div>

            <!-- Linear Price & Time Slider -->
            <div class="modal-linear-slider-wrapper" style="margin-block: 8px 4px;">
              <input 
                type="range" 
                id="gcash-linear-slider" 
                class="modal-linear-slider" 
                min="5" 
                max="120" 
                step="1" 
                value="${Math.max(5, Math.min(120, this.selectedDuration))}" 
                aria-label="Linear price and time adjustment slider"
              >
              <div class="slider-ticks">
                <span>₱5 (5m)</span>
                <span>₱30 (30m)</span>
                <span>₱60 (60m)</span>
                <span>₱90 (90m)</span>
                <span>₱120 (120m)</span>
              </div>
            </div>

            <!-- Incremental Buttons identical to Cash (+ ₱1, + ₱5, + ₱10, + ₱20) -->
            <div class="coin-buttons" role="group" aria-label="Amount increment buttons">
              <button type="button" class="coin-btn gcash-coin-btn" data-coin="1">+ ₱1</button>
              <button type="button" class="coin-btn gcash-coin-btn" data-coin="5">+ ₱5</button>
              <button type="button" class="coin-btn gcash-coin-btn coin-btn--recommended" data-coin="10">+ ₱10</button>
              <button type="button" class="coin-btn gcash-coin-btn" data-coin="20">+ ₱20</button>
            </div>
          </div>

          <!-- Stylized QR Code Box -->
          <div class="qr-container" style="margin-bottom: 14px;">
            <div class="qr-box">
              <svg class="qr-svg" viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <rect width="160" height="160" fill="#ffffff" rx="8"/>
                <rect x="14" y="14" width="36" height="36" fill="#0c1d1b" rx="4"/>
                <rect x="20" y="20" width="24" height="24" fill="#ffffff" rx="2"/>
                <rect x="25" y="25" width="14" height="14" fill="#12969b" rx="2"/>

                <rect x="110" y="14" width="36" height="36" fill="#0c1d1b" rx="4"/>
                <rect x="116" y="20" width="24" height="24" fill="#ffffff" rx="2"/>
                <rect x="121" y="25" width="14" height="14" fill="#12969b" rx="2"/>

                <rect x="14" y="110" width="36" height="36" fill="#0c1d1b" rx="4"/>
                <rect x="20" y="116" width="24" height="24" fill="#ffffff" rx="2"/>
                <rect x="25" y="121" width="14" height="14" fill="#12969b" rx="2"/>

                <g fill="#0c1d1b">
                  <rect x="58" y="18" width="8" height="8" rx="1"/>
                  <rect x="74" y="18" width="8" height="8" rx="1"/>
                  <rect x="90" y="18" width="8" height="8" rx="1"/>
                  <rect x="58" y="34" width="16" height="8" rx="1"/>
                  <rect x="82" y="34" width="8" height="8" rx="1"/>
                  <rect x="58" y="50" width="8" height="8" rx="1"/>
                  <rect x="74" y="50" width="16" height="8" rx="1"/>
                  <rect x="98" y="50" width="8" height="8" rx="1"/>
                  <rect x="18" y="58" width="8" height="16" rx="1"/>
                  <rect x="34" y="58" width="16" height="8" rx="1"/>
                  <rect x="18" y="82" width="16" height="8" rx="1"/>
                  <rect x="42" y="74" width="8" height="16" rx="1"/>
                  <rect x="114" y="58" width="8" height="8" rx="1"/>
                  <rect x="130" y="58" width="16" height="8" rx="1"/>
                  <rect x="114" y="74" width="16" height="8" rx="1"/>
                  <rect x="138" y="74" width="8" height="16" rx="1"/>
                  <rect x="58" y="114" width="16" height="8" rx="1"/>
                  <rect x="82" y="114" width="8" height="8" rx="1"/>
                  <rect x="58" y="130" width="8" height="16" rx="1"/>
                  <rect x="74" y="138" width="16" height="8" rx="1"/>
                  <rect x="98" y="130" width="8" height="8" rx="1"/>
                  <rect x="114" y="114" width="8" height="16" rx="1"/>
                  <rect x="130" y="122" width="16" height="8" rx="1"/>
                  <rect x="122" y="138" width="8" height="8" rx="1"/>
                  <rect x="138" y="138" width="8" height="8" rx="1"/>
                </g>

                <circle cx="80" cy="80" r="16" fill="#12969b"/>
                <path d="M80 72L74 81H78.5L78 88L85 79H80.5L80 72Z" fill="#ffffff"/>
              </svg>
            </div>
            <div class="qr-methods">
              <span class="qr-method-pill">GCash</span>
              <span class="qr-method-pill">Maya</span>
              <span class="qr-method-pill">QRPH</span>
            </div>
          </div>

          <button type="button" class="btn btn--primary btn--full" id="confirm-gcash-btn">
            ${t("gcash_proceed_btn")} (₱${this.selectedDuration})
          </button>
        </div>
      </div>
    `;

    this.dialog.querySelector("#modal-close-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.close();
    });
    this.dialog.querySelector("#modal-back-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showPaySelectStep();
    });

    const gcashSlider = this.dialog.querySelector("#gcash-linear-slider");
    const balEl = this.dialog.querySelector("#gcash-balance-val");
    const minEl = this.dialog.querySelector("#gcash-minutes-val");
    const procBtn = this.dialog.querySelector("#confirm-gcash-btn");

    const updateGCashDisplays = () => {
      if (balEl) balEl.textContent = `₱${this.selectedDuration}`;
      if (minEl) minEl.textContent = `${this.selectedDuration} ${t("cash_mins_suffix")}`;
      if (procBtn) procBtn.textContent = `${t("gcash_proceed_btn")} (₱${this.selectedDuration})`;
      if (gcashSlider) gcashSlider.value = Math.max(5, Math.min(120, this.selectedDuration));
    };

    gcashSlider?.addEventListener("input", (e) => {
      const val = parseInt(e.target.value, 10);
      this.selectedDuration = val;
      updateGCashDisplays();
    });

    this.dialog.querySelectorAll(".gcash-coin-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const val = parseInt(btn.dataset.coin, 10);
        this.selectedDuration = Math.min(120, Math.max(5, (this.selectedDuration || 0) + val));
        updateGCashDisplays();
      });
    });

    this.dialog.querySelector("#confirm-gcash-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.selectedMethod = "GCash";
      this.showConfirmStep();
    });
  }

  /**
   * STEP 2: Confirm Step
   */
  showConfirmStep() {
    this.activeStep = "confirm";
    const port = this.currentPort;
    const t = (k) => i18n.t(k);
    const amount = this.selectedDuration;

    this.dialog.innerHTML = `
      <div class="modal-card">
        ${this._renderStepsHeader(2)}

        <div class="modal-body modal-body--confirm">
          <button type="button" class="modal-back-btn" id="modal-back-btn" aria-label="Go back to edit payment">
            ${t("btn_back")}
          </button>

          <h2 class="modal-section-title">${t("confirm_title")}</h2>
          <p class="modal-instructions">${t("confirm_desc")}</p>

          <div class="confirm-summary-card">
            <div class="confirm-row">
              <span class="confirm-label">${t("confirm_port_label")}</span>
              <strong class="confirm-val">${port.name}</strong>
            </div>
            <div class="confirm-row">
              <span class="confirm-label">${t("confirm_method_label")}</span>
              <strong class="confirm-val">${this.selectedMethod}</strong>
            </div>
            <div class="confirm-row">
              <span class="confirm-label">${t("confirm_duration_label")}</span>
              <strong class="confirm-val">${this.selectedDuration} mins</strong>
            </div>
            <div class="confirm-row confirm-row--total">
              <span class="confirm-label">${t("confirm_total_label")}</span>
              <strong class="confirm-val confirm-val--accent">₱${amount}.00</strong>
            </div>
          </div>

          <button type="button" class="btn btn--primary btn--full" id="confirm-next-btn">
            ${t("confirm_proceed_btn")}
          </button>
        </div>
      </div>
    `;

    this.dialog.querySelector("#modal-close-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.close();
    });
    this.dialog.querySelector("#modal-back-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.selectedMethod === "Cash") this.showPayCashStep();
      else this.showPayGCashStep();
    });
    this.dialog.querySelector("#confirm-next-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showConnectStep();
    });
  }

  /**
   * STEP 3: Connect Step
   */
  showConnectStep() {
    this.activeStep = "connect";
    const port = this.currentPort;
    const t = (k) => i18n.t(k);

    this.dialog.innerHTML = `
      <div class="modal-card">
        ${this._renderStepsHeader(3)}

        <div class="modal-body modal-body--connect">
          <button type="button" class="modal-back-btn" id="modal-back-btn" aria-label="Go back to confirm step">
            ${t("btn_back")}
          </button>

          <h2 class="modal-section-title">${t("connect_title")}</h2>
          <p class="modal-instructions">${t("connect_desc")}</p>

          <div class="connect-illustration">
            <div class="connect-icon-pulse">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M18 12h-5m0 0l3-3m-3 3l3 3M6 12h5m0 0l-3-3m3 3l-3 3"/>
              </svg>
            </div>
            <span class="connect-port-badge">${port.name}</span>
          </div>

          <button type="button" class="btn btn--primary btn--full" id="start-charging-btn">
            ${t("connect_btn")}
          </button>
        </div>
      </div>
    `;

    this.dialog.querySelector("#modal-close-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.close();
    });
    this.dialog.querySelector("#modal-back-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showConfirmStep();
    });
    this.dialog.querySelector("#start-charging-btn")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      const button = e.currentTarget;
      button.disabled = true;
      button.textContent = "Reserving port...";
      try {
        const session = await this.state.startSession(
          this.currentPort.id,
          this.selectedDuration,
          this.selectedMethod === "Cash" && document.documentElement.dataset.demoMode === "on"
            ? "Demo Cash"
            : this.selectedMethod,
          "Phone",
          { collectionId: this.selectedMethod === "Cash" ? this.coinCollection?.collectionId : null }
        );
        this.coinCollection = null;
        this.activeSession = session;
        this.showChargingStep(session);
      } catch (error) {
        button.disabled = false;
        button.textContent = error.message || "Unable to reserve port";
        button.title = error.message || "Unable to reserve port";
        if (/already in use/i.test(error.message || "")) {
          setTimeout(() => this.close(), 1800);
        }
      }
    });
  }

  /**
   * STEP 4: Active Charging Session Overlay (Screenshot 3)
   */
  showChargingStep(session) {
    this.activeStep = "charging";
    this.activeSession = session;
    const port = this.currentPort || this.state.getPort(session.portId);
    const t = (k) => i18n.t(k);

    const m = Math.floor(session.remainingSeconds / 60);
    const s = session.remainingSeconds % 60;
    const timeFormatted = `${m}:${s < 10 ? "0" : ""}${s}`;
    const progressPercent = Math.max(0, Math.min(100, (session.remainingSeconds / session.totalSeconds) * 100));

    this.dialog.innerHTML = `
      <div class="modal-card">
        ${this._renderStepsHeader(4)}

        <div class="modal-body modal-body--charging">
          <!-- Port Title Row with In-use Pill -->
          <div class="port-title-row">
            <h2 class="modal-port-name">${port.name}</h2>
            <span class="port-status-pill port-status-pill--in-use">${t("status_in_use")}</span>
          </div>

          <!-- Big Countdown Timer Display -->
          <div class="charging-timer-display">
            <span class="charging-timer-val" id="charging-timer-val">${timeFormatted}</span>
            <span class="charging-timer-sub">${t("active_time_remaining")}</span>
          </div>

          <!-- Linear Gradient Progress Bar -->
          <div class="charging-linear-progress" role="progressbar" aria-valuenow="${Math.round(progressPercent)}" aria-valuemin="0" aria-valuemax="100">
            <div class="charging-linear-fill" id="charging-linear-fill" style="width: ${progressPercent}%;"></div>
          </div>

          <!-- 2x2 Telemetry Grid (Phone / 9W / Paid / Port) -->
          <div class="charging-stats-2x2">
            <div class="charging-stat-box">
              <span class="charging-stat-label">${t("active_device_detected")}</span>
              <strong class="charging-stat-val" id="stat-device">${session.device || "Phone"}</strong>
            </div>

            <div class="charging-stat-box">
              <span class="charging-stat-label">${t("active_power_draw")}</span>
              <strong class="charging-stat-val" id="stat-watts">${session.watts || 9} W</strong>
            </div>

            <div class="charging-stat-box">
              <span class="charging-stat-label">${t("active_paid")}</span>
              <strong class="charging-stat-val">${session.paid || "₱15 · Cash"}</strong>
            </div>

            <div class="charging-stat-box">
              <span class="charging-stat-label">${t("active_port")}</span>
              <strong class="charging-stat-val">${port.name}</strong>
            </div>
          </div>

          <!-- Action Buttons -->
          <div class="charging-actions-group">
            <button type="button" class="btn--done" id="charging-done-btn">
              ${t("active_btn_done")}
            </button>
            <button type="button" class="btn--stop" id="charging-stop-btn">
              Stop charging early
            </button>
          </div>

          <!-- Footnote -->
          <p class="charging-footer-note">
            ${t("active_footer_caption")}
          </p>
        </div>
      </div>
    `;

    this.dialog.querySelector("#modal-close-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.close();
    });
    this.dialog.querySelector("#charging-done-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.close();
    });
    this.dialog.querySelector("#charging-stop-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const portId = this.currentPort ? this.currentPort.id : (session ? session.portId : null);
      if (portId) {
        this.state.completeSession(portId, false);
      }
      this.close();
    });
  }

  _updateActiveTimerView(session) {
    const timerVal = this.dialog.querySelector("#charging-timer-val");
    const progressFill = this.dialog.querySelector("#charging-linear-fill");
    const wattsVal = this.dialog.querySelector("#stat-watts");

    const m = Math.floor(session.remainingSeconds / 60);
    const s = session.remainingSeconds % 60;
    const timeFormatted = `${m}:${s < 10 ? "0" : ""}${s}`;
    const progressPercent = Math.max(0, Math.min(100, (session.remainingSeconds / session.totalSeconds) * 100));

    if (timerVal) timerVal.textContent = timeFormatted;
    if (progressFill) progressFill.style.width = `${progressPercent}%`;
    if (wattsVal) {
      // Subtle natural fluctuation
      const fluc = (session.watts || 9) + Math.floor((Math.random() - 0.5) * 2);
      wattsVal.textContent = `${fluc} W`;
    }
  }

  _renderCurrentStep() {
    switch (this.activeStep) {
      case "pay-select":
        this.showPaySelectStep();
        break;
      case "pay-cash":
        this.showPayCashStep();
        break;
      case "pay-gcash":
        this.showPayGCashStep();
        break;
      case "confirm":
        this.showConfirmStep();
        break;
      case "connect":
        this.showConnectStep();
        break;
      case "charging":
        if (this.activeSession) this.showChargingStep(this.activeSession);
        break;
      case "hardware-occupied":
        if (this.currentPort) {
          const channel = this.state.getHardwareChannel(this.currentPort.id);
          if (channel) this.showHardwareOccupiedStep(channel);
        }
        break;
    }
  }
}
