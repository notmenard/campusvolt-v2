#pragma once

// Copy this file to secrets.h. Never commit the real values.
#define CAMPUSVOLT_WIFI_SSID "YOUR_WIFI_NAME"
#define CAMPUSVOLT_WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#define CAMPUSVOLT_STATION_API_KEY "PASTE_THE_VERCEL_STATION_API_KEY"

// Replace -1 only after checking the final schematic and relay-driver polarity.
// Unconfigured outputs remain fail-closed and refuse relay-on commands.
#define CAMPUSVOLT_RELAY_PIN_OUTLET_1 -1
#define CAMPUSVOLT_RELAY_PIN_OUTLET_2 -1
#define CAMPUSVOLT_RELAY_PIN_TYPE_C -1
#define CAMPUSVOLT_RELAY_PIN_MICRO_USB -1
#define CAMPUSVOLT_RELAY_PIN_LIGHTNING -1
#define CAMPUSVOLT_RELAY_PIN_WIRELESS -1
#define CAMPUSVOLT_RELAY_ACTIVE_HIGH 1

// One shared pulse-output coin acceptor. Leave pins at -1 until the final
// wiring and voltage-level interface have been verified. Never connect a
// 12 V coin signal directly to an ESP32 GPIO.
#define CAMPUSVOLT_COIN_SIGNAL_PIN -1
#define CAMPUSVOLT_COIN_INHIBIT_PIN -1
#define CAMPUSVOLT_COIN_SIGNAL_ACTIVE_LOW 1
#define CAMPUSVOLT_COIN_INHIBIT_ACTIVE_HIGH 1

// Calibrate these pulse counts to the programmed coin acceptor.
#define CAMPUSVOLT_COIN_PULSES_1_PHP 1
#define CAMPUSVOLT_COIN_PULSES_5_PHP 5
#define CAMPUSVOLT_COIN_PULSES_10_PHP 10
#define CAMPUSVOLT_COIN_PULSES_20_PHP 20

// PEM root certificate for the certificate chain used by campusvolt-v2.vercel.app.
// Keep certificate validation enabled; do not replace this with setInsecure().
#define CAMPUSVOLT_ROOT_CA R"EOF(
-----BEGIN CERTIFICATE-----
PASTE_CURRENT_ROOT_CA_CERTIFICATE_HERE
-----END CERTIFICATE-----
)EOF"
