# BMS BLE GATT inspector

This temporary diagnostic sketch targets only `BMC1_AC2F` at
`34:DA:4C:82:AC:2F`. It connects, lists the GATT services and characteristics,
and polls only the BMC protocol's handshake, battery-info, cell-voltage, and
running-status read commands. It never sends FET, calibration, clear-status, or
configuration commands and does not change BMS settings. Enabling notifications
may update the standard BLE subscription descriptor on the BMS connection.

1. Disconnect charging loads while temporary diagnostic firmware is installed.
2. Keep the BMS powered and awake.
3. Force-close the manufacturer's phone application and disconnect it from the
   BMS.
4. Verify and upload `bms-ble-gatt-inspector.ino`.
5. Open Serial Monitor at 115200 baud.
6. Copy the complete service/characteristic listing and any notification data.
7. Restore `esp32-campusvolt.ino` after inspection.

The sketch holds the active-low DC relay GPIOs 25, 26, 32, and 5 HIGH/off. It
is still diagnostic firmware, not the production electrical safety controller.
