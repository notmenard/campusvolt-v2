# CampusVolt ESP32 starter

This Arduino-framework sketch implements the authenticated five-second
heartbeat, the website's schema version 1, and leased relay commands returned
by the server. It deliberately leaves sensor and relay pins in a safe,
de-energized state until they are matched to the final schematic.

## Start here

1. Install an ESP32 Arduino core and ArduinoJson 7.x.
2. Copy `secrets.example.h` to `secrets.h`.
3. Add the Wi-Fi credentials, the same station API key configured in Vercel,
   and the current trusted root CA for `campusvolt-v2.vercel.app`.
4. Set all six `CAMPUSVOLT_RELAY_PIN_*` values and relay polarity only after
   checking the final schematic. A pin left at `-1` refuses on commands.
5. Replace `readChannel()` with the two PZEM-004T adapters and four calibrated
   DC-channel adapters.
6. Replace `readStationTelemetry()` with the Gentai BMS and solar-controller
   adapters.
7. Add over-current, temperature, BMS, and emergency-stop shutdown rules to
   `maintainLocalElectricalSafety()`; these always override cloud commands.
8. Confirm current direction: positive means charging the battery; negative
   means discharging it.
9. Run the PowerShell heartbeat and relay workflow before flashing physical
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

Do not use `WiFiClientSecure::setInsecure()` in a deployed kiosk. Cloud
connectivity must never be required for over-current, temperature, BMS, relay,
or emergency-stop protection.
