#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <time.h>

#include "secrets.h"

namespace {
constexpr char kApiUrl[] = "https://campusvolt-v2.vercel.app/api/station-status";
constexpr char kStationId[] = "station-01";
constexpr char kFirmwareVersion[] = "0.2.0-relay-control";
constexpr uint32_t kHeartbeatIntervalMs = 5000;
constexpr uint32_t kWifiRetryIntervalMs = 5000;
constexpr uint32_t kMaximumCommandLeaseMs = 15000;

const char* kChannelIds[] = {
  "outlet-1", "outlet-2", "dc-type-c", "dc-micro-usb",
  "dc-lightning", "wireless-pad"
};
constexpr size_t kChannelCount = sizeof(kChannelIds) / sizeof(kChannelIds[0]);

// Define these six values in secrets.h after confirming the final schematic.
// A value of -1 keeps that output fail-closed and refuses relay-on commands.
#ifndef CAMPUSVOLT_RELAY_PIN_OUTLET_1
#define CAMPUSVOLT_RELAY_PIN_OUTLET_1 -1
#endif
#ifndef CAMPUSVOLT_RELAY_PIN_OUTLET_2
#define CAMPUSVOLT_RELAY_PIN_OUTLET_2 -1
#endif
#ifndef CAMPUSVOLT_RELAY_PIN_TYPE_C
#define CAMPUSVOLT_RELAY_PIN_TYPE_C -1
#endif
#ifndef CAMPUSVOLT_RELAY_PIN_MICRO_USB
#define CAMPUSVOLT_RELAY_PIN_MICRO_USB -1
#endif
#ifndef CAMPUSVOLT_RELAY_PIN_LIGHTNING
#define CAMPUSVOLT_RELAY_PIN_LIGHTNING -1
#endif
#ifndef CAMPUSVOLT_RELAY_PIN_WIRELESS
#define CAMPUSVOLT_RELAY_PIN_WIRELESS -1
#endif
#ifndef CAMPUSVOLT_RELAY_ACTIVE_HIGH
#define CAMPUSVOLT_RELAY_ACTIVE_HIGH 1
#endif

const int8_t kRelayPins[kChannelCount] = {
  CAMPUSVOLT_RELAY_PIN_OUTLET_1,
  CAMPUSVOLT_RELAY_PIN_OUTLET_2,
  CAMPUSVOLT_RELAY_PIN_TYPE_C,
  CAMPUSVOLT_RELAY_PIN_MICRO_USB,
  CAMPUSVOLT_RELAY_PIN_LIGHTNING,
  CAMPUSVOLT_RELAY_PIN_WIRELESS,
};

struct ChannelReading {
  bool inUse;
  float watts;
  float voltageV;
  float currentA;
  bool relayOn;
  const char* fault;
};

struct StationTelemetry {
  bool bmsConnected;
  float soc;
  float batteryVoltageV;
  float batteryCurrentA;
  float batteryPowerW;
  float batteryTemperatureC;
  const char* protection;
  float solarPowerW;
  float solarEnergyTodayWh;
  float panelVoltageV;
};

uint32_t lastHeartbeatAt = 0;
uint32_t lastWifiAttemptAt = 0;
uint32_t messageSequence = 0;
uint32_t bootId = 0;
bool relayStates[kChannelCount] = {false, false, false, false, false, false};
uint32_t relayLeaseDeadlines[kChannelCount] = {0, 0, 0, 0, 0, 0};
String lastAppliedCommandId;

void writeRelayLevel(size_t index, bool enabled) {
  const int8_t pin = kRelayPins[index];
  if (pin < 0) return;
  const uint8_t onLevel = CAMPUSVOLT_RELAY_ACTIVE_HIGH ? HIGH : LOW;
  digitalWrite(pin, enabled ? onLevel : (onLevel == HIGH ? LOW : HIGH));
}

bool setRelayOutput(size_t index, bool enabled) {
  if (index >= kChannelCount) return false;
  if (enabled && kRelayPins[index] < 0) {
    Serial.printf("Refusing relay-on for %s: pin is not configured.\n", kChannelIds[index]);
    relayStates[index] = false;
    relayLeaseDeadlines[index] = 0;
    return false;
  }
  writeRelayLevel(index, enabled);
  relayStates[index] = enabled;
  if (!enabled) relayLeaseDeadlines[index] = 0;
  return true;
}

void initializeRelaysFailClosed() {
  for (size_t index = 0; index < kChannelCount; ++index) {
    if (kRelayPins[index] >= 0) {
      pinMode(kRelayPins[index], OUTPUT);
      writeRelayLevel(index, false);
    }
    relayStates[index] = false;
    relayLeaseDeadlines[index] = 0;
  }
}

bool updateOccupancyWithHysteresis(bool previous, float watts) {
  constexpr float kTurnOnThresholdW = 1.5f;
  constexpr float kTurnOffThresholdW = 0.5f;
  return previous ? watts >= kTurnOffThresholdW : watts >= kTurnOnThresholdW;
}

ChannelReading readChannel(size_t channelIndex) {
  // Replace this safe placeholder with the calibrated PZEM/DC sensor adapter
  // for channelId. Never energize a relay solely because the cloud is online.
  (void)channelIndex;
  return {false, 0.0f, 0.0f, 0.0f, relayStates[channelIndex], nullptr};
}

StationTelemetry readStationTelemetry() {
  // Replace with the Gentai BMS and solar-controller adapters. Until then,
  // report the BMS as disconnected so the website applies its safety pause.
  return {
    false, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, "bms-disconnected",
    0.0f, 0.0f, 0.0f
  };
}

void maintainLocalElectricalSafety() {
  // Apply over-current, over-temperature, BMS, and emergency-stop rules here.
  // This must run independently of Wi-Fi and HTTP success.
  const uint32_t now = millis();
  for (size_t index = 0; index < kChannelCount; ++index) {
    if (relayStates[index]
        && (relayLeaseDeadlines[index] == 0
            || static_cast<int32_t>(now - relayLeaseDeadlines[index]) >= 0)) {
      Serial.printf("Relay lease expired for %s; turning output off.\n", kChannelIds[index]);
      setRelayOutput(index, false);
    }
  }
}

bool applyRelayControl(const String& responseBody) {
  JsonDocument response;
  if (deserializeJson(response, responseBody) != DeserializationError::Ok) return false;
  JsonObject control = response["control"].as<JsonObject>();
  if (control.isNull() || control["schemaVersion"].as<int>() != 1) return false;

  const int64_t nowEpochMs = static_cast<int64_t>(time(nullptr)) * 1000LL;
  const int64_t validUntil = control["validUntil"] | 0LL;
  if (validUntil <= nowEpochMs) return false;

  const uint32_t nowMillis = millis();
  bool fullyApplied = true;
  for (size_t index = 0; index < kChannelCount; ++index) {
    JsonObject command = control["channels"][kChannelIds[index]].as<JsonObject>();
    if (command.isNull()) {
      setRelayOutput(index, false);
      fullyApplied = false;
      continue;
    }

    const bool requestedOn = command["relayOn"] | false;
    const int64_t authorizedUntil = command["authorizedUntil"] | 0LL;
    const int64_t channelValidUntil = requestedOn ? min(validUntil, authorizedUntil) : validUntil;
    if (!requestedOn || channelValidUntil <= nowEpochMs) {
      fullyApplied = setRelayOutput(index, false) && fullyApplied;
      continue;
    }

    const int64_t remainingLeaseMs = channelValidUntil - nowEpochMs;
    const uint32_t leaseMs = static_cast<uint32_t>(
      remainingLeaseMs < kMaximumCommandLeaseMs ? remainingLeaseMs : kMaximumCommandLeaseMs
    );
    if (setRelayOutput(index, true)) relayLeaseDeadlines[index] = nowMillis + leaseMs;
    else fullyApplied = false;
  }

  if (fullyApplied) lastAppliedCommandId = String(control["commandId"] | "");
  return fullyApplied;
}

bool clockIsSynchronized() {
  return time(nullptr) > 1700000000;
}

void connectWifiIfNeeded() {
  if (WiFi.status() == WL_CONNECTED) return;
  const uint32_t now = millis();
  if (now - lastWifiAttemptAt < kWifiRetryIntervalMs) return;
  lastWifiAttemptAt = now;
  WiFi.mode(WIFI_STA);
  WiFi.begin(CAMPUSVOLT_WIFI_SSID, CAMPUSVOLT_WIFI_PASSWORD);
}

bool sendHeartbeat() {
  if (WiFi.status() != WL_CONNECTED || !clockIsSynchronized()) return false;

  JsonDocument document;
  document["schemaVersion"] = 1;
  document["stationId"] = kStationId;
  document["messageId"] = String(kStationId) + "-" + String(bootId, HEX) + "-" + String(++messageSequence);
  document["sentAt"] = static_cast<int64_t>(time(nullptr)) * 1000LL;
  document["firmwareVersion"] = kFirmwareVersion;
  document["rssi"] = WiFi.RSSI();
  if (!lastAppliedCommandId.isEmpty()) document["lastAppliedCommandId"] = lastAppliedCommandId;

  JsonObject channels = document["channels"].to<JsonObject>();
  for (size_t index = 0; index < kChannelCount; ++index) {
    const char* channelId = kChannelIds[index];
    const ChannelReading reading = readChannel(index);
    JsonObject channel = channels[channelId].to<JsonObject>();
    channel["inUse"] = reading.inUse;
    channel["watts"] = reading.watts;
    channel["voltageV"] = reading.voltageV;
    channel["currentA"] = reading.currentA;
    channel["relayOn"] = reading.relayOn;
    if (reading.fault && reading.fault[0]) channel["fault"] = reading.fault;
    else channel["fault"] = nullptr;
  }

  const StationTelemetry reading = readStationTelemetry();
  JsonObject battery = document["telemetry"]["battery"].to<JsonObject>();
  battery["connected"] = reading.bmsConnected;
  battery["soc"] = reading.soc;
  battery["voltageV"] = reading.batteryVoltageV;
  battery["currentA"] = reading.batteryCurrentA;
  battery["powerW"] = reading.batteryPowerW;
  battery["temperatureC"] = reading.batteryTemperatureC;
  battery["protection"] = reading.protection;

  JsonObject solar = document["telemetry"]["solar"].to<JsonObject>();
  solar["powerW"] = reading.solarPowerW;
  solar["energyTodayWh"] = reading.solarEnergyTodayWh;
  solar["panelVoltageV"] = reading.panelVoltageV;
  solar["controllerState"] = reading.solarPowerW > 1.0f ? "generating" : "idle";

  String body;
  serializeJson(document, body);

  WiFiClientSecure tls;
  tls.setCACert(CAMPUSVOLT_ROOT_CA);
  HTTPClient http;
  if (!http.begin(tls, kApiUrl)) return false;
  http.addHeader("Authorization", String("Bearer ") + CAMPUSVOLT_STATION_API_KEY);
  http.addHeader("Content-Type", "application/json");
  const int status = http.POST(body);
  const String response = http.getString();
  http.end();

  Serial.printf("Heartbeat HTTP %d: %s\n", status, response.c_str());
  if (status != HTTP_CODE_ACCEPTED) return false;
  return applyRelayControl(response);
}
}  // namespace

void setup() {
  Serial.begin(115200);
  bootId = esp_random();
  initializeRelaysFailClosed();
  WiFi.setAutoReconnect(true);
  connectWifiIfNeeded();
  configTime(0, 0, "pool.ntp.org", "time.google.com");
}

void loop() {
  maintainLocalElectricalSafety();
  connectWifiIfNeeded();

  const uint32_t now = millis();
  if (now - lastHeartbeatAt >= kHeartbeatIntervalMs) {
    lastHeartbeatAt = now;
    sendHeartbeat();
  }
  delay(20);
}
