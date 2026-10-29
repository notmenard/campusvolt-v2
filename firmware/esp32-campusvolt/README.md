# CampusVolt ESP32 starter

This Arduino-framework sketch implements the authenticated five-second
heartbeat, the website's schema version 1, and leased relay commands returned
by the server. It deliberately leaves sensor and relay pins in a safe,
de-energized state until they are matched to the final schematic.

## Start here

1. Install an ESP32 Arduino core and ArduinoJson 7.x.
   In Arduino IDE select **Tools → Partition Scheme → Huge APP (3MB No
   OTA/1MB SPIFFS)**. The combined Wi-Fi, TLS, BLE, relay, and coin firmware is
   about 1.80 MB and does not fit the default 1.31 MB application partition.
   This partition supports USB flashing but not OTA firmware updates.
2. Copy `secrets.example.h` to `secrets.h`.
3. Add the Wi-Fi credentials, the same station API key configured in Vercel,
   and the current trusted root CA for `campusvolt-v2.vercel.app`.
4. The initial DC-only mapping from the 2026-10-28 schematic is Type-C GPIO25,
   Micro USB GPIO26, Lightning GPIO32, and Wireless GPIO5. Outlet 1 and
   Outlet 2 remain `-1` until the Q9/Q10 stages are tested separately. Confirm
   the four-relay module's trigger polarity before connecting any load; a pin
   left at `-1` refuses on commands.
5. The Allan selector signal is ESP32 GPIO27, confirmed by continuity from the
   PC817 output on the final assembly. The four-wire selector has no inhibit
   input, so leave the inhibit pin at `-1`. Never connect its 12 V COIN output
   directly to an ESP32 GPIO; it must remain behind the PC817 interface.
6. Replace `readChannel()` with the two PZEM-004T adapters and four calibrated
   DC-channel adapters.
7. The inspected BMC BLE battery protocol is integrated read-only. Confirm the
   BMS name, MAC address, and nominal pack voltage in `secrets.h`. The solar
   controller remains a safe zero placeholder.
8. Add over-current, temperature, BMS, and emergency-stop shutdown rules to
   `maintainLocalElectricalSafety()`; these always override cloud commands.
9. Confirm current direction: positive means charging the battery; negative
   means discharging it.
10. Run the PowerShell heartbeat, coin, and relay workflow before flashing physical
   sensor code.

## Relay behavior

Every accepted heartbeat returns a complete command for all six outputs. A
paid, unexpired session authorizes only its matching output. The ESP32 applies
the command, reports its `lastAppliedCommandId` on the next heartbeat, and
turns an output off when its 15-second lease expires. Clicking **Stop charging
early** or reaching `00:00` removes the session, so the next heartbeat commands
that output off (normally within five seconds).

The cloud is never a safety controller: a local BMS, emergency-stop, thermal,
or over-current condition must immediately de-energize the affected output.
No response, malformed JSON, an expired lease, or an unconfigured pin must also
leave the output off.

## BLE BMS monitoring

The production sketch now connects to `34:DA:4C:82:AC:2F`, subscribes to the
known notification characteristic, and rotates the read-only battery-info,
cell-voltage, and running-status requests every three seconds. It publishes
SOC, pack voltage/current/power, temperature, remaining/full capacity, SOH,
cycle count, and cell min/max/delta through the normal five-second heartbeat.

The BMS phone application must be disconnected because this BMS accepts one
BLE client at a time. A reading older than 20 seconds is reported as stale and
`connected: false`; cached values are not presented as current measurements.
Reconnect scanning is limited to three seconds and is attempted only while all
relays and coin handling are idle, so a blocking BLE scan cannot starve an
active relay lease or coin pulse workflow. The integration sends no FET,
configuration, calibration, or clear-status commands. A fresh BMS protection
bit immediately turns all relays off, rejects new relay-on commands, and is
reported as a channel fault; warnings remain visible telemetry and do not
independently switch loads.

Do not use `WiFiClientSecure::setInsecure()` in a deployed kiosk. Cloud
connectivity must never be required for over-current, temperature, BMS, relay,
or emergency-stop protection.

## Coin workflow

The customer selects a channel and target amount on the dashboard. The next
heartbeat returns a short-lived `coinControl` lease. Only then does the ESP32
enable coin capture. It groups pulses and maps them to PHP 1/5/10, and
posts idempotent events to `/api/station-coins`. After the target is reached,
the website creates the paid session and the normal relay lease starts.

The six Allan profiles use duplicate value mappings: both old/new PHP 1 coins
use `P=1`, both old/new PHP 5 coins use `P=5`, and both old/new PHP 10 coins use
`P=10`. Keep AP mode at `1` so the configured pulse counts reach the ESP32.

The website session—not a plug-presence sensor—owns channel availability. The
firmware reports electrical measurements and faults but does not attempt to
detect whether a phone is physically plugged in.

## Administrator maintenance console

Set `CAMPUSVOLT_ADMIN_PASSWORD` on Vercel and in the PowerShell window used to
start the local Python server. It is separate from the station API key and must
never be placed in `secrets.h` or browser JavaScript. Open **Settings → Hardware
maintenance** to access the protected console.

The console can issue one five-second DC/HW-298 output lease, run an isolated
two-minute Allan coin test, and show the latest voltage/current/power fields
from each station heartbeat. Maintenance coins never create customer credit.
Customer sessions override output tests, and an offline ESP32 cannot be tested.

The INA table is already connected to `channels.*.voltageV`, `currentA`, and
`watts`, but the production sketch still returns safe zero placeholders from
`readChannel()`. Install and calibrate the actual INA219 adapters only after
their I2C addresses and shunt values are confirmed; do not guess these values.
