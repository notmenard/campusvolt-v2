#include <Arduino.h>
#include <ArduinoJson.h>
#include <BLEAdvertisedDevice.h>
#include <BLEClient.h>
#include <BLEDevice.h>
#include <BLERemoteCharacteristic.h>
#include <BLERemoteService.h>
#include <BLEScan.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <time.h>
#include <vector>

#include "secrets.h"

namespace {
constexpr char kApiUrl[] = "https://campusvolt-v2.vercel.app/api/station-status";
constexpr char kCoinApiUrl[] = "https://campusvolt-v2.vercel.app/api/station-coins";
constexpr char kStationId[] = "station-01";
constexpr char kFirmwareVersion[] = "0.5.0-bms-ble-monitor";
constexpr uint32_t kHeartbeatIntervalMs = 5000;
constexpr uint32_t kWifiRetryIntervalMs = 5000;
constexpr uint32_t kMaximumCommandLeaseMs = 15000;
constexpr uint32_t kCoinPulseDebounceUs = 18000;
constexpr uint32_t kCoinPulseTrainGapMs = 350;
constexpr uint32_t kCoinRetryIntervalMs = 2000;
constexpr uint32_t kBmsPollIntervalMs = 3000;
constexpr uint32_t kBmsReconnectIntervalMs = 30000;
constexpr uint32_t kBmsFreshnessMs = 20000;
constexpr uint32_t kBmsConnectTimeoutMs = 5000;
constexpr uint32_t kBmsScanSeconds = 3;

#ifndef CAMPUSVOLT_BMS_BLE_NAME
#define CAMPUSVOLT_BMS_BLE_NAME "BMC1_AC2F"
#endif
#ifndef CAMPUSVOLT_BMS_BLE_ADDRESS
#define CAMPUSVOLT_BMS_BLE_ADDRESS "34:da:4c:82:ac:2f"
#endif
#ifndef CAMPUSVOLT_BMS_NOMINAL_VOLTAGE
#define CAMPUSVOLT_BMS_NOMINAL_VOLTAGE 12.8f
#endif

constexpr char kBmsServiceUuid[] = "00000001-0000-1000-8000-00805f9b34fb";
constexpr char kBmsCommandUuid[] = "00000002-0000-1000-8000-00805f9b34fb";
constexpr char kBmsNotifyUuid[] = "00000003-0000-1000-8000-00805f9b34fb";
constexpr uint8_t kBmsReadCommands[] = {0x21, 0x22, 0x20};

#ifndef CAMPUSVOLT_COIN_SIGNAL_PIN
#define CAMPUSVOLT_COIN_SIGNAL_PIN -1
#endif
#ifndef CAMPUSVOLT_COIN_INHIBIT_PIN
#define CAMPUSVOLT_COIN_INHIBIT_PIN -1
#endif
#ifndef CAMPUSVOLT_COIN_SIGNAL_ACTIVE_LOW
#define CAMPUSVOLT_COIN_SIGNAL_ACTIVE_LOW 1
#endif
#ifndef CAMPUSVOLT_COIN_INHIBIT_ACTIVE_HIGH
#define CAMPUSVOLT_COIN_INHIBIT_ACTIVE_HIGH 1
#endif
#ifndef CAMPUSVOLT_COIN_PULSES_1_PHP
#define CAMPUSVOLT_COIN_PULSES_1_PHP 1
#endif
#ifndef CAMPUSVOLT_COIN_PULSES_5_PHP
#define CAMPUSVOLT_COIN_PULSES_5_PHP 5
#endif
#ifndef CAMPUSVOLT_COIN_PULSES_10_PHP
#define CAMPUSVOLT_COIN_PULSES_10_PHP 10
#endif

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
#define CAMPUSVOLT_RELAY_ACTIVE_HIGH 0
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
  const char* batteryStatus;
  bool hasBatteryDetails;
  float ratedCapacityAh;
  float ratedEnergyWh;
  float remainingAh;
  float remainingEnergyWh;
  float healthPercent;
  uint32_t cycleCount;
  bool hasCellDetails;
  float cellMinVoltageV;
  float cellMaxVoltageV;
  float cellDeltaMv;
  float solarPowerW;
  float solarEnergyTodayWh;
  float panelVoltageV;
};

struct BmsTelemetryState {
  bool linkConnected;
  float voltageV;
  float currentA;
  float soc;
  float healthPercent;
  float remainingAh;
  float fullCapacityAh;
  uint32_t cycleCount;
  float batteryTemperatureC;
  float mosTemperatureC;
  float cellMinVoltageV;
  float cellMaxVoltageV;
  float cellDeltaMv;
  uint8_t cellCount;
  uint32_t statusBits;
  uint32_t protectionMask;
  uint32_t warningMask;
  uint32_t batteryUpdatedAt;
  uint32_t cellsUpdatedAt;
  uint32_t statusUpdatedAt;
};

uint32_t lastHeartbeatAt = 0;
uint32_t lastWifiAttemptAt = 0;
uint32_t messageSequence = 0;
uint32_t bootId = 0;
bool relayStates[kChannelCount] = {false, false, false, false, false, false};
uint32_t relayLeaseDeadlines[kChannelCount] = {0, 0, 0, 0, 0, 0};
String lastAppliedCommandId;
String activeCoinCollectionId;
volatile bool coinAcceptorEnabled = false;
uint32_t coinLeaseDeadline = 0;
volatile uint16_t coinPulseCount = 0;
volatile uint32_t lastCoinPulseUs = 0;
uint16_t lastReportedCoinPulseCount = 0;
uint32_t coinEventSequence = 0;
uint32_t lastCoinPostAttemptAt = 0;
BLEClient* bmsClient = nullptr;
BLERemoteCharacteristic* bmsCommandCharacteristic = nullptr;
BLERemoteCharacteristic* bmsNotifyCharacteristic = nullptr;
std::vector<uint8_t> bmsResponseFrame;
uint32_t lastBmsPollAt = 0;
uint32_t lastBmsReconnectAttemptAt = 0;
size_t bmsReadCommandIndex = 0;
portMUX_TYPE bmsStateMux = portMUX_INITIALIZER_UNLOCKED;
BmsTelemetryState bmsState = {};

struct PendingCoinEvent {
  bool active;
  String collectionId;
  String eventId;
  uint16_t pulseCount;
  uint8_t denomination;
};
PendingCoinEvent pendingCoin = {false, "", "", 0, 0};

// Forward declaration because coin-event delivery checks the synchronized
// clock before the function's definition later in this translation unit.
bool clockIsSynchronized();

uint16_t readUint16Le(const uint8_t* data) {
  return static_cast<uint16_t>(data[0])
    | (static_cast<uint16_t>(data[1]) << 8);
}

uint32_t readUint32Le(const uint8_t* data) {
  return static_cast<uint32_t>(data[0])
    | (static_cast<uint32_t>(data[1]) << 8)
    | (static_cast<uint32_t>(data[2]) << 16)
    | (static_cast<uint32_t>(data[3]) << 24);
}

int32_t readInt32Le(const uint8_t* data) {
  return static_cast<int32_t>(readUint32Le(data));
}

void setBmsLinkConnected(bool connected) {
  portENTER_CRITICAL(&bmsStateMux);
  bmsState.linkConnected = connected;
  portEXIT_CRITICAL(&bmsStateMux);
}

bool bmsProtectionIsActive() {
  uint32_t protectionMask;
  uint32_t statusUpdatedAt;
  portENTER_CRITICAL(&bmsStateMux);
  protectionMask = bmsState.protectionMask;
  statusUpdatedAt = bmsState.statusUpdatedAt;
  portEXIT_CRITICAL(&bmsStateMux);
  const uint32_t now = millis();
  return statusUpdatedAt != 0 && now - statusUpdatedAt <= kBmsFreshnessMs && protectionMask != 0;
}

void parseBmsBatteryInfo(const uint8_t* data, size_t length) {
  if (length < 26) {
    Serial.printf("Rejected short BMS battery-info payload: %u bytes.\n", static_cast<unsigned>(length));
    return;
  }
  const float voltageV = readInt32Le(data) / 1000.0f;
  const float currentA = readInt32Le(data + 4) / 1000.0f;
  const uint8_t soc = data[8];
  const uint8_t health = data[9];
  const float remainingAh = readUint32Le(data + 10) / 1000.0f;
  const float fullCapacityAh = readUint32Le(data + 14) / 1000.0f;
  const int8_t batteryTemperatureC = static_cast<int8_t>(data[20]);
  const int8_t mosTemperatureC = static_cast<int8_t>(data[25]);
  if (voltageV < 0.0f || voltageV > 100.0f || currentA < -200.0f || currentA > 200.0f
      || soc > 100 || health > 100 || fullCapacityAh <= 0.0f || fullCapacityAh > 2000.0f
      || remainingAh < 0.0f || remainingAh > 2000.0f
      || batteryTemperatureC < -40 || batteryTemperatureC > 120) {
    Serial.println("Rejected out-of-range BMS battery-info payload.");
    return;
  }

  portENTER_CRITICAL(&bmsStateMux);
  bmsState.voltageV = voltageV;
  bmsState.currentA = currentA;
  bmsState.soc = soc;
  bmsState.healthPercent = health;
  bmsState.remainingAh = remainingAh;
  bmsState.fullCapacityAh = fullCapacityAh;
  bmsState.cycleCount = readUint16Le(data + 18);
  bmsState.batteryTemperatureC = batteryTemperatureC;
  bmsState.mosTemperatureC = mosTemperatureC;
  bmsState.batteryUpdatedAt = millis();
  portEXIT_CRITICAL(&bmsStateMux);
  Serial.printf("BMS: %.3f V, %.3f A, SOC %.0f%%, SOH %.0f%%.\n", voltageV, currentA, float(soc), float(health));
}

void parseBmsCellVoltages(const uint8_t* data, size_t length) {
  const size_t availableCells = min(static_cast<size_t>(24), length / 2);
  uint16_t minimumMv = UINT16_MAX;
  uint16_t maximumMv = 0;
  uint8_t cellCount = 0;
  for (size_t index = 0; index < availableCells; ++index) {
    const uint16_t millivolts = readUint16Le(data + index * 2);
    if (millivolts == 0) continue;
    if (millivolts > 6000) {
      Serial.println("Rejected out-of-range BMS cell-voltage payload.");
      return;
    }
    ++cellCount;
    minimumMv = min(minimumMv, millivolts);
    maximumMv = max(maximumMv, millivolts);
  }
  if (cellCount == 0) return;

  portENTER_CRITICAL(&bmsStateMux);
  bmsState.cellCount = cellCount;
  bmsState.cellMinVoltageV = minimumMv / 1000.0f;
  bmsState.cellMaxVoltageV = maximumMv / 1000.0f;
  bmsState.cellDeltaMv = maximumMv - minimumMv;
  bmsState.cellsUpdatedAt = millis();
  portEXIT_CRITICAL(&bmsStateMux);
  Serial.printf("BMS cells: %u, min %.3f V, max %.3f V, delta %u mV.\n",
    cellCount, minimumMv / 1000.0f, maximumMv / 1000.0f, maximumMv - minimumMv);
}

void parseBmsRunningStatus(const uint8_t* data, size_t length) {
  if (length < 8) {
    Serial.printf("Rejected short BMS status payload: %u bytes.\n", static_cast<unsigned>(length));
    return;
  }
  const uint32_t status = readUint32Le(data + 4);
  const uint32_t protectionMask = status
    & (0x0000003FUL | 0x00004000UL | 0x007F0000UL | 0x40000000UL);
  const uint32_t warningMask = status & (0x00003F00UL | 0x3F000000UL);
  portENTER_CRITICAL(&bmsStateMux);
  bmsState.statusBits = status;
  bmsState.protectionMask = protectionMask;
  bmsState.warningMask = warningMask;
  bmsState.statusUpdatedAt = millis();
  portEXIT_CRITICAL(&bmsStateMux);
  Serial.printf("BMS status 0x%08lX: protection %s, warnings %s.\n",
    static_cast<unsigned long>(status), protectionMask ? "ACTIVE" : "normal",
    warningMask ? "ACTIVE" : "none");
}

void parseBmsFrame(const std::vector<uint8_t>& frame) {
  if (frame.size() < 5 || frame[0] != 0xAA) return;
  const size_t payloadLength = frame[2];
  if (frame.size() != payloadLength + 5) return;
  uint16_t checksum = 0;
  for (size_t index = 1; index < 3 + payloadLength; ++index) {
    checksum = static_cast<uint16_t>(checksum + frame[index]);
  }
  if (checksum != readUint16Le(frame.data() + 3 + payloadLength)) {
    Serial.println("Rejected BMS response with an invalid checksum.");
    return;
  }
  const uint8_t command = frame[1];
  const uint8_t* payload = frame.data() + 3;
  if (command == 0x21) parseBmsBatteryInfo(payload, payloadLength);
  else if (command == 0x22) parseBmsCellVoltages(payload, payloadLength);
  else if (command == 0x20) parseBmsRunningStatus(payload, payloadLength);
}

void bmsNotificationCallback(
  BLERemoteCharacteristic*, uint8_t* data, size_t length, bool
) {
  if (length > 0 && data[0] == 0xAA) bmsResponseFrame.clear();
  if (bmsResponseFrame.empty() && (length == 0 || data[0] != 0xAA)) return;
  bmsResponseFrame.insert(bmsResponseFrame.end(), data, data + length);
  if (bmsResponseFrame.size() > 128) {
    bmsResponseFrame.clear();
    return;
  }
  if (bmsResponseFrame.size() >= 3) {
    const size_t expectedLength = static_cast<size_t>(bmsResponseFrame[2]) + 5;
    if (bmsResponseFrame.size() >= expectedLength) {
      bmsResponseFrame.resize(expectedLength);
      parseBmsFrame(bmsResponseFrame);
      bmsResponseFrame.clear();
    }
  }
}

class BmsClientCallbacks : public BLEClientCallbacks {
 public:
  void onConnect(BLEClient*) override {
    setBmsLinkConnected(true);
    Serial.println("BMS BLE connected.");
  }

  void onDisconnect(BLEClient*) override {
    setBmsLinkConnected(false);
    bmsCommandCharacteristic = nullptr;
    bmsNotifyCharacteristic = nullptr;
    bmsResponseFrame.clear();
    Serial.println("BMS BLE disconnected; telemetry will fail closed when stale.");
  }
};

BmsClientCallbacks bmsClientCallbacks;

bool stationOutputsAreIdle() {
  if (coinAcceptorEnabled || pendingCoin.active) return false;
  for (bool relayState : relayStates) {
    if (relayState) return false;
  }
  return true;
}

bool sendBmsReadRequest(uint8_t command) {
  if (bmsClient == nullptr || !bmsClient->isConnected() || bmsCommandCharacteristic == nullptr) return false;
  uint8_t frame[] = {0xAA, command, 0x00, command, 0x00};
  return bmsCommandCharacteristic->writeValue(frame, sizeof(frame), true);
}

bool connectBmsIfIdle() {
  if (bmsClient != nullptr && bmsClient->isConnected()) return true;
  if (!stationOutputsAreIdle()) return false;
  const uint32_t now = millis();
  if (lastBmsReconnectAttemptAt != 0 && now - lastBmsReconnectAttemptAt < kBmsReconnectIntervalMs) return false;
  lastBmsReconnectAttemptAt = now;

  Serial.printf("Scanning %lu seconds for BMS %s (%s)...\n",
    static_cast<unsigned long>(kBmsScanSeconds), CAMPUSVOLT_BMS_BLE_NAME, CAMPUSVOLT_BMS_BLE_ADDRESS);
  BLEScan* scanner = BLEDevice::getScan();
  scanner->setActiveScan(true);
  scanner->setInterval(100);
  scanner->setWindow(90);
  BLEScanResults* results = scanner->start(kBmsScanSeconds, false);
  if (results == nullptr) return false;

  bool found = false;
  BLEAdvertisedDevice target;
  for (int index = 0; index < results->getCount(); ++index) {
    BLEAdvertisedDevice candidate = results->getDevice(index);
    const bool addressMatches = candidate.getAddress().toString().equalsIgnoreCase(CAMPUSVOLT_BMS_BLE_ADDRESS);
    const bool nameMatches = candidate.haveName() && candidate.getName().equalsIgnoreCase(CAMPUSVOLT_BMS_BLE_NAME);
    if (addressMatches || nameMatches) {
      target = candidate;
      found = true;
      break;
    }
  }
  if (!found) {
    scanner->clearResults();
    Serial.println("Configured BMS was not found.");
    return false;
  }

  if (bmsClient == nullptr) {
    bmsClient = BLEDevice::createClient();
    bmsClient->setClientCallbacks(&bmsClientCallbacks);
  }
  Serial.println("Connecting to BMS...");
  const bool connected = bmsClient->connectTimeout(&target, kBmsConnectTimeoutMs);
  scanner->clearResults();
  if (!connected) {
    setBmsLinkConnected(false);
    Serial.println("BMS connection failed. Close its phone app and keep the BMS awake.");
    return false;
  }

  bmsClient->setMTU(185);
  BLERemoteService* service = bmsClient->getService(BLEUUID(kBmsServiceUuid));
  if (service == nullptr) {
    Serial.println("BMS service was not found.");
    bmsClient->disconnect();
    return false;
  }
  bmsCommandCharacteristic = service->getCharacteristic(BLEUUID(kBmsCommandUuid));
  bmsNotifyCharacteristic = service->getCharacteristic(BLEUUID(kBmsNotifyUuid));
  if (bmsCommandCharacteristic == nullptr || bmsNotifyCharacteristic == nullptr
      || !bmsCommandCharacteristic->canWrite() || !bmsNotifyCharacteristic->canNotify()) {
    Serial.println("BMS command/notification characteristics are unavailable.");
    bmsClient->disconnect();
    return false;
  }
  bmsNotifyCharacteristic->registerForNotify(bmsNotificationCallback, true);
  setBmsLinkConnected(true);
  sendBmsReadRequest(0x00);
  lastBmsPollAt = millis();
  bmsReadCommandIndex = 0;
  return true;
}

void maintainBmsMonitoring() {
  if (bmsClient == nullptr || !bmsClient->isConnected()) {
    setBmsLinkConnected(false);
    connectBmsIfIdle();
    return;
  }
  const uint32_t now = millis();
  if (now - lastBmsPollAt < kBmsPollIntervalMs) return;
  const uint8_t command = kBmsReadCommands[bmsReadCommandIndex];
  if (sendBmsReadRequest(command)) {
    bmsReadCommandIndex = (bmsReadCommandIndex + 1) % (sizeof(kBmsReadCommands) / sizeof(kBmsReadCommands[0]));
  }
  lastBmsPollAt = now;
}

void setCoinAcceptorEnabled(bool enabled) {
  // The four-wire Allan selector has no inhibit input. In that configuration
  // the selector remains physically powered and firmware ignores pulses unless
  // the backend has issued an active coin-collection lease.
  const bool wasEnabled = coinAcceptorEnabled;
  enabled = enabled && CAMPUSVOLT_COIN_SIGNAL_PIN >= 0;
  coinAcceptorEnabled = enabled;
  if (enabled != wasEnabled) {
    Serial.printf(
      "Coin capture %s on GPIO%d (input level=%s).\n",
      enabled ? "ENABLED" : "DISABLED",
      CAMPUSVOLT_COIN_SIGNAL_PIN,
      CAMPUSVOLT_COIN_SIGNAL_PIN >= 0 && digitalRead(CAMPUSVOLT_COIN_SIGNAL_PIN) == HIGH ? "HIGH" : "LOW"
    );
  }
  if (CAMPUSVOLT_COIN_INHIBIT_PIN < 0) return;
  const uint8_t enabledLevel = CAMPUSVOLT_COIN_INHIBIT_ACTIVE_HIGH ? LOW : HIGH;
  digitalWrite(CAMPUSVOLT_COIN_INHIBIT_PIN, enabled ? enabledLevel : (enabledLevel == HIGH ? LOW : HIGH));
}

void IRAM_ATTR onCoinPulse() {
  if (!coinAcceptorEnabled) return;
  const uint32_t nowUs = micros();
  if (nowUs - lastCoinPulseUs < kCoinPulseDebounceUs) return;
  lastCoinPulseUs = nowUs;
  if (coinPulseCount < 100) ++coinPulseCount;
}

uint8_t denominationForPulses(uint16_t pulses) {
  if (pulses == CAMPUSVOLT_COIN_PULSES_1_PHP) return 1;
  if (pulses == CAMPUSVOLT_COIN_PULSES_5_PHP) return 5;
  if (pulses == CAMPUSVOLT_COIN_PULSES_10_PHP) return 10;
  return 0;
}

void initializeCoinAcceptorFailClosed() {
  if (CAMPUSVOLT_COIN_INHIBIT_PIN >= 0) {
    pinMode(CAMPUSVOLT_COIN_INHIBIT_PIN, OUTPUT);
    setCoinAcceptorEnabled(false);
  }
  if (CAMPUSVOLT_COIN_SIGNAL_PIN >= 0) {
    pinMode(CAMPUSVOLT_COIN_SIGNAL_PIN, CAMPUSVOLT_COIN_SIGNAL_ACTIVE_LOW ? INPUT_PULLUP : INPUT_PULLDOWN);
    attachInterrupt(digitalPinToInterrupt(CAMPUSVOLT_COIN_SIGNAL_PIN), onCoinPulse,
      CAMPUSVOLT_COIN_SIGNAL_ACTIVE_LOW ? FALLING : RISING);
    Serial.printf(
      "Coin input ready: GPIO%d, active-%s, idle level=%s.\n",
      CAMPUSVOLT_COIN_SIGNAL_PIN,
      CAMPUSVOLT_COIN_SIGNAL_ACTIVE_LOW ? "LOW" : "HIGH",
      digitalRead(CAMPUSVOLT_COIN_SIGNAL_PIN) == HIGH ? "HIGH" : "LOW"
    );
  } else {
    Serial.println("Coin input disabled: CAMPUSVOLT_COIN_SIGNAL_PIN is not configured.");
  }
}

void reportCoinPulseProgress() {
  if (!coinAcceptorEnabled) return;
  noInterrupts();
  const uint16_t pulses = coinPulseCount;
  interrupts();
  if (pulses == 0 || pulses == lastReportedCoinPulseCount) return;
  lastReportedCoinPulseCount = pulses;
  Serial.printf("Coin pulse counted on GPIO%d: %u pulse(s) so far.\n",
    CAMPUSVOLT_COIN_SIGNAL_PIN, pulses);
}

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
  if (enabled && bmsProtectionIsActive()) {
    Serial.printf("Refusing relay-on for %s: BMS protection is active.\n", kChannelIds[index]);
    writeRelayLevel(index, false);
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

ChannelReading readChannel(size_t channelIndex) {
  // Replace this safe placeholder with the calibrated PZEM/DC sensor adapter
  // for channelId. Never energize a relay solely because the cloud is online.
  (void)channelIndex;
  return {
    0.0f, 0.0f, 0.0f, relayStates[channelIndex],
    bmsProtectionIsActive() ? "bms-protection" : nullptr
  };
}

StationTelemetry readStationTelemetry() {
  BmsTelemetryState snapshot;
  portENTER_CRITICAL(&bmsStateMux);
  snapshot = bmsState;
  portEXIT_CRITICAL(&bmsStateMux);

  const uint32_t now = millis();
  const bool batteryFresh = snapshot.linkConnected && snapshot.batteryUpdatedAt != 0
    && now - snapshot.batteryUpdatedAt <= kBmsFreshnessMs;
  const bool statusFresh = snapshot.statusUpdatedAt != 0
    && now - snapshot.statusUpdatedAt <= kBmsFreshnessMs;
  const bool cellsFresh = snapshot.cellsUpdatedAt != 0
    && now - snapshot.cellsUpdatedAt <= kBmsFreshnessMs;

  StationTelemetry telemetry = {};
  telemetry.bmsConnected = batteryFresh;
  telemetry.protection = !snapshot.linkConnected ? "bms-disconnected"
    : !batteryFresh ? "bms-data-stale"
    : !statusFresh ? "status-stale"
    : snapshot.protectionMask ? "active"
    : snapshot.warningMask ? "warning" : "normal";
  telemetry.batteryStatus = batteryFresh
    ? (snapshot.currentA > 0.05f ? "charging" : snapshot.currentA < -0.05f ? "discharging" : "idle")
    : "idle";
  telemetry.solarPowerW = 0.0f;
  telemetry.solarEnergyTodayWh = 0.0f;
  telemetry.panelVoltageV = 0.0f;
  if (!batteryFresh) return telemetry;

  telemetry.soc = snapshot.soc;
  telemetry.batteryVoltageV = snapshot.voltageV;
  telemetry.batteryCurrentA = snapshot.currentA;
  telemetry.batteryPowerW = snapshot.voltageV * snapshot.currentA;
  telemetry.batteryTemperatureC = snapshot.batteryTemperatureC;
  telemetry.hasBatteryDetails = true;
  telemetry.ratedCapacityAh = snapshot.fullCapacityAh;
  telemetry.ratedEnergyWh = snapshot.fullCapacityAh * CAMPUSVOLT_BMS_NOMINAL_VOLTAGE;
  telemetry.remainingAh = snapshot.remainingAh;
  telemetry.remainingEnergyWh = snapshot.remainingAh * snapshot.voltageV;
  telemetry.healthPercent = snapshot.healthPercent;
  telemetry.cycleCount = snapshot.cycleCount;
  telemetry.hasCellDetails = cellsFresh && snapshot.cellCount > 0;
  telemetry.cellMinVoltageV = snapshot.cellMinVoltageV;
  telemetry.cellMaxVoltageV = snapshot.cellMaxVoltageV;
  telemetry.cellDeltaMv = snapshot.cellDeltaMv;
  return telemetry;
}

void maintainLocalElectricalSafety() {
  // This must run independently of Wi-Fi and HTTP success. INA over-current,
  // emergency-stop, and enclosure-temperature rules still need their final
  // hardware adapters; an active, fresh BMS protection state is enforced now.
  const uint32_t now = millis();
  const bool bmsProtectionActive = bmsProtectionIsActive();
  for (size_t index = 0; index < kChannelCount; ++index) {
    if (relayStates[index] && bmsProtectionActive) {
      Serial.printf("BMS protection is active; turning off %s.\n", kChannelIds[index]);
      setRelayOutput(index, false);
    } else if (relayStates[index]
        && (relayLeaseDeadlines[index] == 0
            || static_cast<int32_t>(now - relayLeaseDeadlines[index]) >= 0)) {
      Serial.printf("Relay lease expired for %s; turning output off.\n", kChannelIds[index]);
      setRelayOutput(index, false);
    }
  }
  if (coinAcceptorEnabled
      && (coinLeaseDeadline == 0 || static_cast<int32_t>(now - coinLeaseDeadline) >= 0)) {
    setCoinAcceptorEnabled(false);
    activeCoinCollectionId = "";
  }
}

void applyCoinControl(JsonObject control) {
  if (control.isNull() || control["schemaVersion"].as<int>() != 1) {
    setCoinAcceptorEnabled(false);
    return;
  }
  const int64_t nowEpochMs = static_cast<int64_t>(time(nullptr)) * 1000LL;
  const int64_t validUntil = control["validUntil"] | 0LL;
  const bool enabled = (control["enabled"] | false) && !pendingCoin.active;
  const String collectionId = String(control["collectionId"] | "");
  if (!enabled || collectionId.isEmpty() || validUntil <= nowEpochMs) {
    setCoinAcceptorEnabled(false);
    activeCoinCollectionId = "";
    return;
  }
  activeCoinCollectionId = collectionId;
  const int64_t requestedLeaseMs = validUntil - nowEpochMs;
  const int64_t remainingMs = requestedLeaseMs < kMaximumCommandLeaseMs
    ? requestedLeaseMs : kMaximumCommandLeaseMs;
  coinLeaseDeadline = millis() + static_cast<uint32_t>(remainingMs);
  setCoinAcceptorEnabled(true);
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

  applyCoinControl(response["coinControl"].as<JsonObject>());
  if (fullyApplied) lastAppliedCommandId = String(control["commandId"] | "");
  return fullyApplied;
}

void captureCompletedCoinPulseTrain() {
  if (!coinAcceptorEnabled || pendingCoin.active) return;
  noInterrupts();
  const uint16_t pulses = coinPulseCount;
  const uint32_t lastPulse = lastCoinPulseUs;
  interrupts();
  if (pulses == 0 || (micros() - lastPulse) / 1000 < kCoinPulseTrainGapMs) return;
  noInterrupts();
  coinPulseCount = 0;
  interrupts();
  lastReportedCoinPulseCount = 0;
  Serial.printf("Coin pulse train complete: %u pulse(s).\n", pulses);
  const uint8_t denomination = denominationForPulses(pulses);
  if (!denomination) {
    Serial.printf("Rejected unknown coin pulse train: %u pulses.\n", pulses);
    return;
  }
  pendingCoin = {
    true,
    activeCoinCollectionId,
    String(kStationId) + "-coin-" + String(bootId, HEX) + "-" + String(++coinEventSequence),
    pulses,
    denomination,
  };
  setCoinAcceptorEnabled(false);
}

void postPendingCoinEvent() {
  if (!pendingCoin.active || WiFi.status() != WL_CONNECTED || !clockIsSynchronized()) return;
  const uint32_t now = millis();
  if (now - lastCoinPostAttemptAt < kCoinRetryIntervalMs) return;
  lastCoinPostAttemptAt = now;

  JsonDocument document;
  document["collectionId"] = pendingCoin.collectionId;
  document["eventId"] = pendingCoin.eventId;
  document["denomination"] = pendingCoin.denomination;
  document["pulseCount"] = pendingCoin.pulseCount;
  String body;
  serializeJson(document, body);

  WiFiClientSecure tls;
  tls.setCACert(CAMPUSVOLT_ROOT_CA);
  HTTPClient http;
  if (!http.begin(tls, kCoinApiUrl)) return;
  http.addHeader("Authorization", String("Bearer ") + CAMPUSVOLT_STATION_API_KEY);
  http.addHeader("Content-Type", "application/json");
  const int status = http.POST(body);
  const String response = http.getString();
  http.end();
  Serial.printf("Coin event HTTP %d: %s\n", status, response.c_str());
  if (status == HTTP_CODE_OK || status == HTTP_CODE_ACCEPTED || status == HTTP_CODE_GONE || status == HTTP_CODE_CONFLICT) {
    pendingCoin.active = false;
  }
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
  battery["status"] = reading.batteryStatus;
  if (reading.hasBatteryDetails) {
    battery["ratedCapacityAh"] = reading.ratedCapacityAh;
    battery["ratedEnergyWh"] = reading.ratedEnergyWh;
    battery["remainingAh"] = reading.remainingAh;
    battery["remainingEnergyWh"] = reading.remainingEnergyWh;
    battery["healthPercent"] = reading.healthPercent;
    battery["cycleCount"] = reading.cycleCount;
  } else {
    battery["ratedCapacityAh"] = nullptr;
    battery["ratedEnergyWh"] = nullptr;
    battery["remainingAh"] = nullptr;
    battery["remainingEnergyWh"] = nullptr;
    battery["healthPercent"] = nullptr;
    battery["cycleCount"] = nullptr;
  }
  if (reading.hasCellDetails) {
    battery["cellMinVoltageV"] = reading.cellMinVoltageV;
    battery["cellMaxVoltageV"] = reading.cellMaxVoltageV;
    battery["cellDeltaMv"] = reading.cellDeltaMv;
  } else {
    battery["cellMinVoltageV"] = nullptr;
    battery["cellMaxVoltageV"] = nullptr;
    battery["cellDeltaMv"] = nullptr;
  }

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
  initializeCoinAcceptorFailClosed();
  BLEDevice::init("");
  WiFi.setAutoReconnect(true);
  connectWifiIfNeeded();
  configTime(0, 0, "pool.ntp.org", "time.google.com");
}

void loop() {
  maintainLocalElectricalSafety();
  reportCoinPulseProgress();
  captureCompletedCoinPulseTrain();
  postPendingCoinEvent();
  maintainBmsMonitoring();
  connectWifiIfNeeded();

  const uint32_t now = millis();
  if (now - lastHeartbeatAt >= kHeartbeatIntervalMs) {
    lastHeartbeatAt = now;
    sendHeartbeat();
  }
  delay(20);
}
