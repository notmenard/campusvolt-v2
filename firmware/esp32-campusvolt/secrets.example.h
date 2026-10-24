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

// PEM root certificate for the certificate chain used by campusvolt-v2.vercel.app.
// Keep certificate validation enabled; do not replace this with setInsecure().
#define CAMPUSVOLT_ROOT_CA R"EOF(
-----BEGIN CERTIFICATE-----
PASTE_CURRENT_ROOT_CA_CERTIFICATE_HERE
-----END CERTIFICATE-----
)EOF"
