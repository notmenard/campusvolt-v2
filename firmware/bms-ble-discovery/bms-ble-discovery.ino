#include <Arduino.h>
#include <BLEAdvertisedDevice.h>
#include <BLEDevice.h>
#include <BLEScan.h>

namespace {
constexpr uint32_t kScanSeconds = 10;
constexpr uint32_t kPauseBetweenScansMs = 2000;
constexpr int8_t kActiveLowRelayPins[] = {25, 26, 32, 5};

BLEScan* scanner = nullptr;

void initializeRelaysOff() {
  for (const int8_t pin : kActiveLowRelayPins) {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, HIGH);
  }
}

String bytesToHex(const String& value) {
  static const char kHex[] = "0123456789ABCDEF";
  String output;
  output.reserve(value.length() * 3);
  for (size_t index = 0; index < value.length(); ++index) {
    const uint8_t byte = static_cast<uint8_t>(value[index]);
    if (index > 0) output += ' ';
    output += kHex[byte >> 4];
    output += kHex[byte & 0x0F];
  }
  return output;
}

void printDevice(BLEAdvertisedDevice& device, int index) {
  Serial.printf("\n[%d] Name: %s\n", index + 1,
    device.haveName() ? device.getName().c_str() : "(unnamed)");
  Serial.printf("    Address: %s\n", device.getAddress().toString().c_str());
  Serial.printf("    RSSI: %d dBm\n", device.getRSSI());
  Serial.printf("    Connectable: %s\n", device.isConnectable() ? "yes" : "no");

  const int serviceCount = device.getServiceUUIDCount();
  if (serviceCount == 0) {
    Serial.println("    Advertised services: none");
  } else {
    Serial.println("    Advertised services:");
    for (int serviceIndex = 0; serviceIndex < serviceCount; ++serviceIndex) {
      Serial.printf("      - %s\n", device.getServiceUUID(serviceIndex).toString().c_str());
    }
  }

  if (device.haveManufacturerData()) {
    Serial.printf("    Manufacturer data: %s\n",
      bytesToHex(device.getManufacturerData()).c_str());
  }

  const int serviceDataCount = device.getServiceDataCount();
  for (int dataIndex = 0; dataIndex < serviceDataCount; ++dataIndex) {
    Serial.printf("    Service data %s: %s\n",
      device.getServiceDataUUID(dataIndex).toString().c_str(),
      bytesToHex(device.getServiceData(dataIndex)).c_str());
  }
}
}  // namespace

void setup() {
  Serial.begin(115200);
  initializeRelaysOff();
  delay(1000);
  Serial.println("CampusVolt read-only BMS BLE discovery");
  Serial.println("Keep the BMS awake and disconnect its phone app during this scan.");

  BLEDevice::init("");
  scanner = BLEDevice::getScan();
  scanner->setActiveScan(true);
  scanner->setInterval(100);
  scanner->setWindow(90);
}

void loop() {
  Serial.printf("\nScanning for BLE devices for %lu seconds...\n",
    static_cast<unsigned long>(kScanSeconds));
  BLEScanResults* results = scanner->start(kScanSeconds, false);
  if (results == nullptr) {
    Serial.println("BLE scan failed.");
  } else {
    Serial.printf("Found %d BLE device(s).\n", results->getCount());
    for (int index = 0; index < results->getCount(); ++index) {
      BLEAdvertisedDevice device = results->getDevice(index);
      printDevice(device, index);
    }
  }

  scanner->clearResults();
  delay(kPauseBetweenScansMs);
}
