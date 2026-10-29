#include <Arduino.h>
#include <BLEAdvertisedDevice.h>
#include <BLEClient.h>
#include <BLEDevice.h>
#include <BLERemoteCharacteristic.h>
#include <BLERemoteService.h>
#include <BLEScan.h>
#include <vector>

namespace {
constexpr char kTargetName[] = "BMC1_AC2F";
constexpr char kTargetAddress[] = "34:da:4c:82:ac:2f";
constexpr uint32_t kScanSeconds = 15;
constexpr int8_t kActiveLowRelayPins[] = {25, 26, 32, 5};

BLEClient* client = nullptr;
BLERemoteCharacteristic* commandCharacteristic = nullptr;
std::vector<uint8_t> responseFrame;
uint32_t lastReadRequestAt = 0;
size_t readCommandIndex = 0;
constexpr uint8_t kReadCommands[] = {0x21, 0x22, 0x20};

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

void initializeRelaysOff() {
  for (const int8_t pin : kActiveLowRelayPins) {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, HIGH);
  }
}

String bytesToHex(const uint8_t* data, size_t length) {
  static const char kHex[] = "0123456789ABCDEF";
  String output;
  output.reserve(length * 3);
  for (size_t index = 0; index < length; ++index) {
    if (index > 0) output += ' ';
    output += kHex[data[index] >> 4];
    output += kHex[data[index] & 0x0F];
  }
  return output;
}

void parseBatteryInfo(const uint8_t* data, size_t length) {
  if (length < 26) {
    Serial.printf("Battery info payload is too short: %u bytes.\n",
      static_cast<unsigned>(length));
    return;
  }
  const float voltageV = readInt32Le(data) / 1000.0f;
  const float currentA = readInt32Le(data + 4) / 1000.0f;
  const uint8_t soc = data[8];
  const uint8_t soh = data[9];
  const uint32_t remainingMah = readUint32Le(data + 10);
  const uint32_t fullMah = readUint32Le(data + 14);
  const uint16_t cycles = readUint16Le(data + 18);
  const int8_t temperatureC = static_cast<int8_t>(data[20]);
  const int8_t mosTemperatureC = static_cast<int8_t>(data[25]);

  Serial.println("--- BMS BATTERY INFO ---");
  Serial.printf("Voltage: %.3f V\n", voltageV);
  Serial.printf("Current: %.3f A (%s)\n", currentA,
    currentA > 0.01f ? "charging" : (currentA < -0.01f ? "discharging" : "idle"));
  Serial.printf("Power: %.2f W\n", voltageV * currentA);
  Serial.printf("SOC: %u %%\n", soc);
  Serial.printf("SOH: %u %%\n", soh);
  Serial.printf("Remaining capacity: %.3f Ah\n", remainingMah / 1000.0f);
  Serial.printf("Full capacity: %.3f Ah\n", fullMah / 1000.0f);
  Serial.printf("Cycle count: %u\n", cycles);
  Serial.printf("Battery temperature: %d C\n", temperatureC);
  Serial.printf("MOS temperature: %d C\n", mosTemperatureC);
}

void parseCellVoltages(const uint8_t* data, size_t length) {
  const size_t availableCells = min(static_cast<size_t>(24), length / 2);
  uint16_t minimumMv = UINT16_MAX;
  uint16_t maximumMv = 0;
  size_t cellCount = 0;
  Serial.println("--- BMS CELL VOLTAGES ---");
  for (size_t index = 0; index < availableCells; ++index) {
    const uint16_t millivolts = readUint16Le(data + index * 2);
    if (millivolts == 0) continue;
    ++cellCount;
    minimumMv = min(minimumMv, millivolts);
    maximumMv = max(maximumMv, millivolts);
    Serial.printf("Cell %u: %.3f V\n", static_cast<unsigned>(index + 1),
      millivolts / 1000.0f);
  }
  if (cellCount == 0) {
    Serial.println("No non-zero cell readings returned.");
    return;
  }
  Serial.printf("Cells: %u | minimum: %.3f V | maximum: %.3f V | delta: %u mV\n",
    static_cast<unsigned>(cellCount), minimumMv / 1000.0f,
    maximumMv / 1000.0f, maximumMv - minimumMv);
}

void parseRunningStatus(const uint8_t* data, size_t length) {
  if (length < 8) {
    Serial.printf("Running-status payload is too short: %u bytes.\n",
      static_cast<unsigned>(length));
    return;
  }
  const uint16_t uptimeDays = readUint16Le(data);
  const uint8_t uptimeHours = data[2];
  const uint8_t uptimeMinutes = data[3];
  const uint32_t status = readUint32Le(data + 4);
  const uint32_t protectionMask = status
    & (0x0000003FUL | 0x00004000UL | 0x007F0000UL | 0x40000000UL);
  const uint32_t warningMask = status
    & (0x00003F00UL | 0x3F000000UL);

  Serial.println("--- BMS RUNNING STATUS ---");
  Serial.printf("Uptime: %u day(s), %u hour(s), %u minute(s)\n",
    uptimeDays, uptimeHours, uptimeMinutes);
  Serial.printf("Status bitfield: 0x%08lX\n", static_cast<unsigned long>(status));
  Serial.printf("Charge FET: %s | Discharge FET: %s | Pre-discharge FET: %s\n",
    status & 0x00000080UL ? "ON" : "OFF",
    status & 0x00800000UL ? "ON" : "OFF",
    status & 0x80000000UL ? "ON" : "OFF");
  Serial.printf("Protection: %s | Warnings: %s\n",
    protectionMask ? "ACTIVE" : "normal",
    warningMask ? "ACTIVE" : "none");
}

void parseCompleteFrame(const std::vector<uint8_t>& frame) {
  if (frame.size() < 5 || frame[0] != 0xAA) return;
  const uint8_t command = frame[1];
  const size_t payloadLength = frame[2];
  if (frame.size() != payloadLength + 5) return;
  const uint16_t expectedChecksum = readUint16Le(frame.data() + 3 + payloadLength);
  uint16_t actualChecksum = 0;
  for (size_t index = 1; index < 3 + payloadLength; ++index) {
    actualChecksum = static_cast<uint16_t>(actualChecksum + frame[index]);
  }
  if (actualChecksum != expectedChecksum) {
    Serial.printf("Rejected BMS frame: checksum 0x%04X, expected 0x%04X.\n",
      actualChecksum, expectedChecksum);
    return;
  }

  Serial.printf("Complete BMS response 0x%02X (%u payload bytes): %s\n",
    command, static_cast<unsigned>(payloadLength),
    bytesToHex(frame.data(), frame.size()).c_str());
  const uint8_t* payload = frame.data() + 3;
  if (command == 0x21) parseBatteryInfo(payload, payloadLength);
  else if (command == 0x22) parseCellVoltages(payload, payloadLength);
  else if (command == 0x20) parseRunningStatus(payload, payloadLength);
}

void notificationCallback(
  BLERemoteCharacteristic* characteristic,
  uint8_t* data,
  size_t length,
  bool isNotify
) {
  Serial.printf("BMS %s from %s (%u bytes): %s\n",
    isNotify ? "notification" : "indication",
    characteristic->getUUID().toString().c_str(),
    static_cast<unsigned>(length),
    bytesToHex(data, length).c_str());

  if (length > 0 && data[0] == 0xAA) responseFrame.clear();
  if (responseFrame.empty() && (length == 0 || data[0] != 0xAA)) return;
  responseFrame.insert(responseFrame.end(), data, data + length);
  if (responseFrame.size() > 128) {
    Serial.println("Discarding oversized BMS response.");
    responseFrame.clear();
    return;
  }
  if (responseFrame.size() >= 3) {
    const size_t expectedLength = static_cast<size_t>(responseFrame[2]) + 5;
    if (responseFrame.size() >= expectedLength) {
      responseFrame.resize(expectedLength);
      parseCompleteFrame(responseFrame);
      responseFrame.clear();
    }
  }
}

bool sendReadRequest(uint8_t command) {
  if (commandCharacteristic == nullptr || client == nullptr || !client->isConnected()) {
    return false;
  }
  uint8_t frame[] = {0xAA, command, 0x00, command, 0x00};
  Serial.printf("Sending read-only BMS request 0x%02X: %s\n", command,
    bytesToHex(frame, sizeof(frame)).c_str());
  return commandCharacteristic->writeValue(frame, sizeof(frame), true);
}

String characteristicProperties(BLERemoteCharacteristic* characteristic) {
  String properties;
  if (characteristic->canRead()) properties += "READ ";
  if (characteristic->canWrite()) properties += "WRITE ";
  if (characteristic->canWriteNoResponse()) properties += "WRITE_NR ";
  if (characteristic->canNotify()) properties += "NOTIFY ";
  if (characteristic->canIndicate()) properties += "INDICATE ";
  if (characteristic->canBroadcast()) properties += "BROADCAST ";
  if (properties.isEmpty()) properties = "none";
  return properties;
}

bool findTarget(BLEAdvertisedDevice& target) {
  BLEScan* scanner = BLEDevice::getScan();
  scanner->setActiveScan(true);
  scanner->setInterval(100);
  scanner->setWindow(90);

  Serial.printf("Scanning %lu seconds for %s (%s)...\n",
    static_cast<unsigned long>(kScanSeconds), kTargetName, kTargetAddress);
  BLEScanResults* results = scanner->start(kScanSeconds, false);
  if (results == nullptr) return false;

  for (int index = 0; index < results->getCount(); ++index) {
    BLEAdvertisedDevice candidate = results->getDevice(index);
    const String address = candidate.getAddress().toString();
    const bool addressMatches = address.equalsIgnoreCase(kTargetAddress);
    const bool nameMatches = candidate.haveName()
      && candidate.getName().equalsIgnoreCase(kTargetName);
    if (addressMatches || nameMatches) {
      target = candidate;
      Serial.printf("Found target: %s at %s, RSSI %d dBm.\n",
        candidate.haveName() ? candidate.getName().c_str() : "(unnamed)",
        address.c_str(), candidate.getRSSI());
      return true;
    }
  }
  return false;
}

void inspectGattDatabase() {
  std::map<std::string, BLERemoteService*>* services = client->getServices();
  if (services == nullptr || services->empty()) {
    Serial.println("Connected, but no GATT services were discovered.");
    return;
  }

  Serial.printf("Discovered %u service(s).\n", static_cast<unsigned>(services->size()));
  for (const auto& serviceEntry : *services) {
    BLERemoteService* service = serviceEntry.second;
    Serial.printf("\nService %s\n", service->getUUID().toString().c_str());
    std::map<std::string, BLERemoteCharacteristic*>* characteristics =
      service->getCharacteristics();
    if (characteristics == nullptr || characteristics->empty()) {
      Serial.println("  No characteristics");
      continue;
    }

    for (const auto& characteristicEntry : *characteristics) {
      BLERemoteCharacteristic* characteristic = characteristicEntry.second;
      Serial.printf("  Characteristic %s | handle 0x%04X | %s\n",
        characteristic->getUUID().toString().c_str(),
        characteristic->getHandle(),
        characteristicProperties(characteristic).c_str());

      if (characteristic->canRead()) {
        const String value = characteristic->readValue();
        Serial.printf("    Initial value (%u bytes): %s\n",
          static_cast<unsigned>(value.length()),
          bytesToHex(reinterpret_cast<const uint8_t*>(value.c_str()), value.length()).c_str());
      }

      if (service->getUUID().equals(BLEUUID("00000001-0000-1000-8000-00805f9b34fb"))
          && characteristic->getUUID().equals(BLEUUID("00000002-0000-1000-8000-00805f9b34fb"))) {
        commandCharacteristic = characteristic;
      }

      if (characteristic->canNotify()) {
        Serial.println("    Subscribing to notifications (no BMS command payload is written).");
        characteristic->registerForNotify(notificationCallback, true);
      } else if (characteristic->canIndicate()) {
        Serial.println("    Subscribing to indications (no BMS command payload is written).");
        characteristic->registerForNotify(notificationCallback, false);
      }
    }
  }
}
}  // namespace

void setup() {
  Serial.begin(115200);
  initializeRelaysOff();
  delay(1000);
  Serial.println("CampusVolt read-only BMS GATT inspector");
  Serial.println("Close the phone BMS app before continuing.");

  BLEDevice::init("");
  BLEAdvertisedDevice target;
  if (!findTarget(target)) {
    Serial.println("Target BMS was not found. Reset the ESP32 to scan again.");
    return;
  }

  client = BLEDevice::createClient();
  Serial.println("Connecting to the BMS...");
  if (!client->connect(&target)) {
    Serial.println("Connection failed. Close the phone app, wake the BMS, and reset the ESP32.");
    return;
  }

  client->setMTU(185);
  Serial.printf("Connected. Negotiated MTU: %u.\n", client->getMTU());
  inspectGattDatabase();
  if (commandCharacteristic == nullptr) {
    Serial.println("BMS command characteristic was not found; read requests are disabled.");
    return;
  }
  delay(300);
  sendReadRequest(0x00);
  lastReadRequestAt = millis();
  Serial.println("\nInspection complete; polling read-only BMS telemetry...");
}

void loop() {
  if (client != nullptr && !client->isConnected()) {
    Serial.println("BMS disconnected. Reset the ESP32 to reconnect.");
    client = nullptr;
  }
  if (client != nullptr && commandCharacteristic != nullptr
      && millis() - lastReadRequestAt >= 3000) {
    sendReadRequest(kReadCommands[readCommandIndex]);
    readCommandIndex = (readCommandIndex + 1) % (sizeof(kReadCommands) / sizeof(kReadCommands[0]));
    lastReadRequestAt = millis();
  }
  delay(1000);
}
