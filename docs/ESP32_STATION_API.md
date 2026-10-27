# ESP32 station integration

The deployed dashboard accepts physical channel, battery/BMS, and solar
measurements from CampusVolt Station 01. The ESP32 makes an outbound HTTPS
request, so no inbound port, static public IP, or router port-forwarding is
required.

## Vercel configuration

Create a long random secret and add it to the Vercel project as a Production
and Preview environment variable:

```text
CAMPUSVOLT_STATION_API_KEY=<at least 32 random characters>
```

Configure the same value in the ESP32 firmware. It must never be included in
browser JavaScript or committed to Git. Redeploy Vercel after adding it.

`CAMPUSVOLT_STATION_ID` is optional and defaults to `station-01`.

## Heartbeat request

The ESP32 must POST a complete snapshot on every sensor-state change and at
least once every five seconds:

```http
POST https://campusvolt-v2.vercel.app/api/station-status
Authorization: Bearer <CAMPUSVOLT_STATION_API_KEY>
Content-Type: application/json
```

```json
{
  "schemaVersion": 1,
  "stationId": "station-01",
  "messageId": "station-01-000184",
  "sentAt": 1792879200000,
  "firmwareVersion": "1.0.0",
  "lastAppliedCommandId": "relay:all-off",
  "rssi": -58,
  "channels": {
    "outlet-1":     { "watts": 42.1, "voltageV": 221.4, "currentA": 0.19, "relayOn": true },
    "outlet-2":     { "watts": 0,    "voltageV": 221.2, "currentA": 0,    "relayOn": false },
    "dc-type-c":    { "watts": 0,    "voltageV": 5.1,   "currentA": 0,    "relayOn": false },
    "dc-micro-usb": { "watts": 0,    "voltageV": 5.1,   "currentA": 0,    "relayOn": false },
    "dc-lightning": { "watts": 0,    "voltageV": 5.1,   "currentA": 0,    "relayOn": false },
    "wireless-pad": { "watts": 0,    "voltageV": 5.1,   "currentA": 0,    "relayOn": false }
  },
  "telemetry": {
    "battery": {
      "connected": true,
      "soc": 82.5,
      "voltageV": 13.31,
      "currentA": 8.4,
      "powerW": 111.8,
      "temperatureC": 31.2,
      "protection": "normal",
      "status": "charging",
      "ratedCapacityAh": 100,
      "ratedEnergyWh": 1280,
      "remainingAh": 82.5,
      "remainingEnergyWh": 1056,
      "healthPercent": 98,
      "cycleCount": 42,
      "cellMinVoltageV": 3.31,
      "cellMaxVoltageV": 3.34,
      "cellDeltaMv": 30
    },
    "solar": {
      "powerW": 285,
      "energyTodayWh": 1800,
      "peakPowerW": 450,
      "panelVoltageV": 18.6,
      "controllerState": "charging"
    }
  }
}
```

`lastAppliedCommandId` is optional during initial bring-up. Production firmware
must send the ID of the most recent command that it successfully applied; this
makes relay acknowledgement visible to the backend.

The endpoint accepts either the `Authorization: Bearer` header above or an
`X-CampusVolt-Key` header. A successful request returns HTTP `202`. Numeric
values outside the accepted electrical ranges, missing channels, invalid
booleans, and unsupported schema versions return HTTP `400` with a field-level
error. A mismatched station ID returns HTTP `409`.

## Heartbeat response and relay commands

Every HTTP `202` response includes a complete, leased relay command:

```json
{
  "accepted": true,
  "heartbeatTtlSeconds": 30,
  "control": {
    "schemaVersion": 1,
    "commandId": "relay:outlet-2@1792879260000",
    "issuedAt": 1792879200000,
    "validUntil": 1792879215000,
    "channels": {
      "outlet-1":     { "relayOn": false, "authorizedUntil": null },
      "outlet-2":     { "relayOn": true,  "authorizedUntil": 1792879215000 },
      "dc-type-c":    { "relayOn": false, "authorizedUntil": null },
      "dc-micro-usb": { "relayOn": false, "authorizedUntil": null },
      "dc-lightning": { "relayOn": false, "authorizedUntil": null },
      "wireless-pad": { "relayOn": false, "authorizedUntil": null }
    }
  }
}
```

The ESP32 must treat this as authorization, not as a safety override:

- Energize a channel only when `relayOn` is true and both `validUntil` and
  `authorizedUntil` are still in the future.
- De-energize every channel omitted from a command or explicitly set false.
- De-energize locally when the 15-second lease expires, even if Wi-Fi or the
  server is unavailable.
- Report the successfully applied `commandId` as `lastAppliedCommandId` in the
  next heartbeat.
- Local emergency-stop, over-current, over-temperature, and BMS protection
  always take priority and must turn power off immediately.

The heartbeat response also includes `coinControl`. When `enabled` is true, it
authorizes the shared coin acceptor for only its `collectionId` and short
`validUntil` lease. Disable/inhibit the acceptor when that lease is absent or
expired. For each completed pulse train, POST an authenticated event:

```http
POST /api/station-coins
Authorization: Bearer <CAMPUSVOLT_STATION_API_KEY>
Content-Type: application/json

{"collectionId":"coins-example","eventId":"station-01-coin-42","denomination":5,"pulseCount":5}
```

Retry the same event ID after transient failures; duplicate IDs do not credit
the coin twice. Pulse mappings must match the programmed physical acceptor.

Starting a paid session produces an on command on the next heartbeat. Stopping
early or reaching the paid end time produces an off command on the next
heartbeat, normally within five seconds. A device that remains plugged in must
receive no power after that relay-off command. Website occupancy comes from the
paid session, not from a plug-presence sensor.

`telemetry` may be omitted during initial channel-sensor bring-up. In that
partial mode, physical occupancy and output measurements are displayed, but
battery and solar values keep their existing source. Production firmware
should send the complete telemetry object so the energy policy uses physical
BMS and solar measurements.

## Required behavior

- Send all six channel IDs in every heartbeat.
- Set `schemaVersion` to `1`, use a unique `messageId`, and set `sentAt` to Unix
  time in milliseconds after the ESP32 has synchronized its clock.
- Do not infer channel ownership from a plug sensor. The website's paid session
  is authoritative for channel occupancy. `inUse` is deprecated and may be
  omitted from heartbeat channels.
- Report `fault` when a sensor, relay, over-current, or over-temperature fault
  occurs. Otherwise omit it or send `null`.
- Use positive battery power/current while charging and negative values while
  discharging. Set `protection` to `normal` only when the BMS confirms that no
  protection condition is active.
- Use HTTPS certificate validation in production firmware.
- Retry transient failures with a bounded backoff, while continuing local
  over-current and relay safety independently of the cloud.
- Never wait for Vercel before applying a local electrical safety shutdown.

Relay authorization expires after 15 seconds without a fresh successful
command. Separately, the Redis hardware record expires 30 seconds after the last accepted
heartbeat. When it expires, dashboards mark the station offline and stop using
the old readings for energy-policy decisions. Website reservations are the
only source of channel occupancy. Hardware measurements remain telemetry, and
hardware faults can still block a channel.

## Sensor adapter boundary

The firmware must produce these normalized values for each channel:

```cpp
struct ChannelReading {
  float watts;
  float voltageV;
  float currentA;
  bool relayOn;
  const char* fault;
};
```

The BMS/solar adapter should also produce one station-level reading:

```cpp
struct StationTelemetry {
  bool bmsConnected;
  float stateOfChargePercent;
  float batteryVoltageV;
  float batteryCurrentA; // positive charging, negative discharging
  float batteryPowerW;
  float batteryTemperatureC;
  const char* protection;
  float solarPowerW;
  float solarEnergyTodayWh;
  float panelVoltageV;
};
```

Use the PZEM-004T adapter for the two AC outlets and the chosen calibrated DC
voltage/current sensor adapters for Type-C, Micro USB, Lightning, and wireless.
The exact ESP32 pins, UART addresses, I2C addresses, and thresholds must match
the final schematic and cannot safely be inferred by the web application.

## Pre-hardware test

Use `scripts/send-station-heartbeat.ps1` to exercise the complete cloud and UI
path before connecting the ESP32:

```powershell
.\scripts\send-station-heartbeat.ps1 -ApiKey '<your-production-key>'
```

For a local all-off heartbeat while testing session commands:

```powershell
.\scripts\send-station-heartbeat.ps1 `
  -ApiKey 'local-development-key-123456789012345' `
  -BaseUrl 'http://localhost:5500' `
  -ActiveChannel none
```

The JSON response should show `relay:all-off` before payment. Start a one-minute
session on Outlet 2, send the heartbeat again, and verify that only
`control.channels.outlet-2.relayOn` is `true`. Click **Stop charging early**,
then send another all-off heartbeat:

```powershell
.\scripts\send-station-heartbeat.ps1 `
  -ApiKey 'local-development-key-123456789012345' `
  -BaseUrl 'http://localhost:5500' `
  -ActiveChannel none `
  -RelayChannel none
```

Verify that the response is `relay:all-off`, Outlet 2 is available on the
website, and its power is `0 W`. This validates the early-stop contract
without switching a physical relay or requiring a presence sensor.

To test the cash path without hardware, choose the channel and target on the
dashboard, click **Start accepting coins**, copy the returned collection ID
from `/api/coin-collections`, and simulate each accepted coin:

```powershell
.\scripts\send-station-coin.ps1 `
  -CollectionId 'coins-copy-this-id' `
  -Denomination 5 `
  -PulseCount 5 `
  -ApiKey 'local-development-key-123456789012345' `
  -BaseUrl 'http://localhost:5500'
```

Use a unique event ID automatically generated by the script. The modal updates
within one second. When the target is reached, continue through Confirm and
Connect; the next heartbeat should authorize only the selected relay.

Within the next dashboard polling interval (three seconds), Station 01 should
show online, and the Battery and Solar panels should switch to ESP32 station
measurements. Channel occupancy changes only when a website session starts or
ends. After heartbeats stop, the station becomes offline in about 30 seconds
and physical telemetry is marked unavailable.
