const CHANNELS = [
  ["dc-type-c", "HW-298 1", "Type-C"],
  ["dc-micro-usb", "HW-298 2", "Micro USB"],
  ["dc-lightning", "HW-298 3", "Lightning"],
  ["wireless-pad", "HW-298 4", "Wireless pad"],
];

const byId = (id) => document.getElementById(id);
let authorized = false;
let pollTimer = null;
let lastState = null;

function toast(message) {
  const element = byId("toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 3200);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || `Request failed (${response.status})`), { status: response.status });
  return payload;
}

function setAuthorized(value) {
  authorized = value;
  byId("login-panel").hidden = value;
  byId("maintenance-content").hidden = !value;
  byId("stop-all").disabled = !value;
  clearInterval(pollTimer);
  if (value) {
    renderRelayCards();
    refresh();
    pollTimer = setInterval(refresh, 1000);
  }
}

function renderRelayCards() {
  byId("relay-grid").innerHTML = CHANNELS.map(([id, board, label]) => `
    <article class="channel"><h3>${board}</h3><p>${label}<br><small>${id}</small></p>
      <button type="button" data-test-port="${id}">Energize for 5 seconds</button></article>`).join("");
}

function render(state) {
  lastState = state;
  const station = state.station || {};
  const pill = byId("station-pill");
  pill.className = `station-pill ${station.online ? "online" : "offline"}`;
  pill.querySelector("b").textContent = station.online
    ? `${station.stationId} online • ${station.firmwareVersion || "unknown firmware"}`
    : "ESP32 station offline";

  const test = state.relayTest;
  byId("relay-status").textContent = test
    ? `${test.portId} energized; automatic cutoff pending.`
    : "No output test active.";
  document.querySelectorAll("[data-test-port]").forEach((button) => {
    button.disabled = !station.online || Boolean(test) || (state.activeSessions || []).length > 0;
  });

  const coin = state.coinTest;
  byId("coin-total").textContent = `₱${coin?.insertedAmount || 0}`;
  byId("coin-detail").textContent = `${coin?.eventCount || 0} accepted pulse train${coin?.eventCount === 1 ? "" : "s"}`;
  byId("coin-test").textContent = coin ? "Stop coin test" : "Start coin test";
  byId("coin-test").disabled = !station.online;

  const channels = station.channels || {};
  byId("ina-body").innerHTML = CHANNELS.map(([id, , label]) => {
    const reading = channels[id] || {};
    return `<tr><td><b>${label}</b><br><small>${id}</small></td><td>${Number(reading.voltageV || 0).toFixed(2)} V</td>
      <td>${Number(reading.currentA || 0).toFixed(3)} A</td><td>${Number(reading.watts || 0).toFixed(2)} W</td>
      <td>${reading.relayOn ? "ON" : "OFF"}</td><td class="${reading.fault ? "fault" : ""}">${reading.fault || "—"}</td></tr>`;
  }).join("");
  byId("telemetry-age").textContent = station.updatedAt
    ? `Updated ${Math.max(0, Math.round((Date.now() - station.updatedAt) / 1000))}s ago`
    : "No ESP32 telemetry received.";
}

async function refresh() {
  if (!authorized) return;
  try {
    render(await request("/api/maintenance"));
  } catch (error) {
    if (error.status === 401) setAuthorized(false);
    else toast(error.message);
  }
}

async function action(body) {
  try {
    await request("/api/maintenance", { method: "POST", body: JSON.stringify(body) });
    await refresh();
  } catch (error) {
    toast(error.message);
  }
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-test-port]");
  if (button) action({ action: "test-relay", portId: button.dataset.testPort });
});

byId("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = byId("login-message");
  message.textContent = "";
  try {
    await request("/api/admin-session", { method: "POST", body: JSON.stringify({ password: byId("admin-password").value }) });
    byId("admin-password").value = "";
    setAuthorized(true);
  } catch (error) {
    message.textContent = error.message;
  }
});

byId("coin-test").addEventListener("click", () => action({ action: lastState?.coinTest ? "stop-coin-test" : "start-coin-test" }));
byId("stop-all").addEventListener("click", () => action({ action: "stop-all" }));
byId("logout").addEventListener("click", async () => {
  await action({ action: "stop-all" });
  await request("/api/admin-session", { method: "DELETE" });
  setAuthorized(false);
});

request("/api/admin-session").then((state) => setAuthorized(state.authorized)).catch((error) => {
  byId("login-message").textContent = error.message;
});
