#include <Arduino.h>

namespace {
constexpr uint32_t kSerialBaud = 115200;
constexpr uint32_t kTestDurationMs = 3000;

// DC relay mapping from the 2026-10-28 CampusVolt schematic.
constexpr uint8_t kRelayPins[] = {25, 26, 32, 5};
const char* const kRelayNames[] = {
  "Relay 1 / Type-C",
  "Relay 2 / Micro USB",
  "Relay 3 / Lightning",
  "Relay 4 / Wireless pad",
};
constexpr size_t kRelayCount = sizeof(kRelayPins) / sizeof(kRelayPins[0]);

// The installed four-channel module was verified to be active-low.
constexpr uint8_t kRelayOnLevel = LOW;
constexpr uint8_t kRelayOffLevel = HIGH;

int activeRelay = -1;
uint32_t turnOffAt = 0;

void allRelaysOff() {
  for (size_t index = 0; index < kRelayCount; ++index) {
    digitalWrite(kRelayPins[index], kRelayOffLevel);
  }
  activeRelay = -1;
  turnOffAt = 0;
}

void printMenu() {
  Serial.println();
  Serial.println("CampusVolt DC relay bench test");
  Serial.println("Enter 1, 2, 3, or 4 to energize one relay for 3 seconds.");
  Serial.println("Enter 0 to turn every relay off immediately.");
}

void testRelay(size_t index) {
  allRelaysOff();
  digitalWrite(kRelayPins[index], kRelayOnLevel);
  activeRelay = static_cast<int>(index);
  turnOffAt = millis() + kTestDurationMs;
  Serial.printf("ON: %s on GPIO %u (automatic OFF in 3 seconds)\n",
                kRelayNames[index], kRelayPins[index]);
}
}  // namespace

void setup() {
  Serial.begin(kSerialBaud);

  // Preload the inactive level before enabling each output to avoid an
  // active-low startup pulse.
  for (size_t index = 0; index < kRelayCount; ++index) {
    digitalWrite(kRelayPins[index], kRelayOffLevel);
    pinMode(kRelayPins[index], OUTPUT);
    digitalWrite(kRelayPins[index], kRelayOffLevel);
  }

  allRelaysOff();
  printMenu();
}

void loop() {
  if (activeRelay >= 0
      && static_cast<int32_t>(millis() - turnOffAt) >= 0) {
    Serial.printf("OFF: %s\n", kRelayNames[activeRelay]);
    allRelaysOff();
  }

  while (Serial.available() > 0) {
    const char command = static_cast<char>(Serial.read());
    if (command >= '1' && command <= '4') {
      testRelay(static_cast<size_t>(command - '1'));
    } else if (command == '0') {
      allRelaysOff();
      Serial.println("OFF: all relays");
    } else if (command != '\r' && command != '\n' && command != ' ') {
      Serial.println("Unknown command. Enter 0, 1, 2, 3, or 4.");
    }
  }
}
