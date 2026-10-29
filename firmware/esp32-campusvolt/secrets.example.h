#pragma once

// Copy this file to secrets.h. Never commit the real values.
#define CAMPUSVOLT_WIFI_SSID "YOUR_WIFI_NAME"
#define CAMPUSVOLT_WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#define CAMPUSVOLT_STATION_API_KEY "PASTE_THE_VERCEL_STATION_API_KEY"

// Final four-channel HW-298 mapping traced from the 2026-10-28 schematic:
// Type-C GPIO25 -> IN1, Micro USB GPIO26 -> IN2,
// Lightning GPIO32 -> IN3, Wireless GPIO5 -> IN4.
// AC outlets remain disabled until the Q9/Q10 stages are tested separately.
// Unconfigured outputs remain fail-closed and refuse relay-on commands.
#define CAMPUSVOLT_RELAY_PIN_OUTLET_1 -1
#define CAMPUSVOLT_RELAY_PIN_OUTLET_2 -1
#define CAMPUSVOLT_RELAY_PIN_TYPE_C 25
#define CAMPUSVOLT_RELAY_PIN_MICRO_USB 26
#define CAMPUSVOLT_RELAY_PIN_LIGHTNING 32
#define CAMPUSVOLT_RELAY_PIN_WIRELESS 5
// Confirm the four-relay module's trigger polarity before connecting loads.
#define CAMPUSVOLT_RELAY_ACTIVE_HIGH 0

// One shared four-wire Allan pulse-output coin selector. Continuity testing on
// the final assembly confirmed the PC817 output reaches ESP32 GPIO27. This
// hardware has no inhibit wire, so the inhibit pin remains -1. Never connect
// the selector's 12 V COIN wire directly to an ESP32 GPIO.
#define CAMPUSVOLT_COIN_SIGNAL_PIN 27
#define CAMPUSVOLT_COIN_INHIBIT_PIN -1
#define CAMPUSVOLT_COIN_SIGNAL_ACTIVE_LOW 1
#define CAMPUSVOLT_COIN_INHIBIT_ACTIVE_HIGH 1

// Program the six Allan profiles as follows:
// old/new PHP 1 -> P=1, old/new PHP 5 -> P=5,
// old/new PHP 10 -> P=10. AP mode must remain 1.
#define CAMPUSVOLT_COIN_PULSES_1_PHP 1
#define CAMPUSVOLT_COIN_PULSES_5_PHP 5
#define CAMPUSVOLT_COIN_PULSES_10_PHP 10

// PEM root certificate for the certificate chain used by campusvolt-v2.vercel.app.
// Keep certificate validation enabled; do not replace this with setInsecure().
#define CAMPUSVOLT_ROOT_CA R"EOF(
-----BEGIN CERTIFICATE-----
PASTE_CURRENT_ROOT_CA_CERTIFICATE_HERE
-----END CERTIFICATE-----
)EOF"
