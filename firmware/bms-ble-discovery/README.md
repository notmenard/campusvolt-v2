# BMS BLE discovery

This temporary, read-only sketch identifies the battery BMS before its
proprietary protocol is added to the CampusVolt station firmware. It scans for
BLE advertisements and prints device names, addresses, RSSI, service UUIDs,
manufacturer data, and service data. It does not connect to or write to a BMS.

1. Keep the BMS powered and awake.
2. Disconnect charging loads while running temporary diagnostic firmware. The
   sketch explicitly keeps the four active-low DC relay pins off, but it is not
   the production safety controller.
3. Disconnect the manufacturer's phone application so it does not hold the
   BMS connection.
4. Upload `bms-ble-discovery.ino` to the ESP32.
5. Open Serial Monitor at 115200 baud.
6. Copy the result for the device that appears only when the BMS is powered.
7. Restore `esp32-campusvolt.ino` after discovery.

If the BMS appears in a phone application but not in this scan, it may use
Bluetooth Classic rather than BLE. Record the phone application name and the
BMS model before selecting a different discovery method.
