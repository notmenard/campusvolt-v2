import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.request import Request, urlopen

import server


class StationPayloadNormalizationTests(unittest.TestCase):
    def test_normalizes_channel_measurements(self):
        channel = server._normalize_channel(
            {
                "inUse": True,
                "watts": 42.1,
                "voltageV": 221.4,
                "currentA": 0.19,
                "relayOn": True,
                "fault": None,
            },
            "outlet-1",
        )
        self.assertTrue(channel["inUse"])
        self.assertEqual(channel["watts"], 42.1)

    def test_rejects_invalid_channel_boolean(self):
        with self.assertRaisesRegex(ValueError, "inUse"):
            server._normalize_channel(
                {
                    "inUse": 1,
                    "watts": 42.1,
                    "voltageV": 221.4,
                    "currentA": 0.19,
                    "relayOn": True,
                },
                "outlet-1",
            )

    def test_normalizes_battery_and_solar_telemetry(self):
        telemetry = server._normalize_telemetry(
            {
                "battery": {
                    "connected": True,
                    "soc": 82.5,
                    "voltageV": 13.31,
                    "currentA": 8.4,
                    "powerW": 111.8,
                    "temperatureC": 31.2,
                    "protection": "normal",
                },
                "solar": {
                    "powerW": 285,
                    "panelVoltageV": 18.6,
                    "controllerState": "charging",
                },
            }
        )
        self.assertEqual(telemetry["battery"]["status"], "charging")
        self.assertEqual(telemetry["solar"]["powerW"], 285)

    def test_rejects_out_of_range_state_of_charge(self):
        with self.assertRaisesRegex(ValueError, "telemetry.battery.soc"):
            server._normalize_telemetry(
                {
                    "battery": {
                        "connected": True,
                        "soc": 101,
                        "voltageV": 13.31,
                        "currentA": 8.4,
                        "powerW": 111.8,
                        "temperatureC": 31.2,
                        "protection": "normal",
                    },
                    "solar": {"powerW": 285},
                }
            )

    def test_relay_control_authorizes_only_active_paid_sessions(self):
        now = int(server.time.time() * 1000)
        control = server._build_relay_control(
            [{"portId": "outlet-2", "endTime": now + 60_000}],
            now,
        )
        self.assertTrue(control["channels"]["outlet-2"]["relayOn"])
        self.assertFalse(control["channels"]["outlet-1"]["relayOn"])
        self.assertLessEqual(control["validUntil"] - control["issuedAt"], 15_000)
        self.assertEqual(control["commandId"], f"relay:outlet-2@{now + 60_000}")

    def test_relay_control_fails_closed_without_a_session(self):
        control = server._build_relay_control([])
        self.assertEqual(control["commandId"], "relay:all-off")
        self.assertTrue(all(not command["relayOn"] for command in control["channels"].values()))


class LocalStationEndpointTests(unittest.TestCase):
    def test_heartbeat_round_trip_exposes_physical_telemetry(self):
        original_state_file = server.STATE_FILE
        original_api_key = server.STATION_API_KEY
        with tempfile.TemporaryDirectory() as directory:
            server.STATE_FILE = Path(directory) / "state.json"
            server.STATION_API_KEY = "local-test-key-with-at-least-32-characters"
            httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.CampusVoltHandler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            try:
                channels = {
                    port_id: {
                        "inUse": port_id == "outlet-1",
                        "watts": 42 if port_id == "outlet-1" else 0,
                        "voltageV": 220 if port_id.startswith("outlet-") else 5.1,
                        "currentA": 0.19 if port_id == "outlet-1" else 0,
                        "relayOn": True,
                        "fault": None,
                    }
                    for port_id in server.PORT_IDS
                }
                payload = {
                    "schemaVersion": 1,
                    "stationId": "station-01",
                    "messageId": "local-round-trip",
                    "sentAt": int(server.time.time() * 1000) - 20,
                    "firmwareVersion": "test-1.0.0",
                    "rssi": -55,
                    "channels": channels,
                    "telemetry": {
                        "battery": {
                            "connected": True,
                            "soc": 82.5,
                            "voltageV": 13.31,
                            "currentA": 8.4,
                            "powerW": 111.8,
                            "temperatureC": 31.2,
                            "protection": "normal",
                        },
                        "solar": {"powerW": 285},
                    },
                }
                base_url = f"http://127.0.0.1:{httpd.server_port}"
                request = Request(
                    f"{base_url}/api/station-status",
                    data=json.dumps(payload).encode("utf-8"),
                    headers={
                        "Authorization": f"Bearer {server.STATION_API_KEY}",
                        "Content-Type": "application/json",
                    },
                    method="POST",
                )
                with urlopen(request, timeout=5) as response:
                    accepted = json.load(response)
                    self.assertEqual(response.status, 202)
                    self.assertTrue(accepted["station"]["online"])
                    self.assertEqual(accepted["control"]["commandId"], "relay:all-off")
                    self.assertTrue(all(
                        not command["relayOn"]
                        for command in accepted["control"]["channels"].values()
                    ))

                with urlopen(f"{base_url}/api/sessions", timeout=5) as response:
                    shared = json.load(response)
                    self.assertEqual(response.status, 200)
                    self.assertEqual(shared["station"]["messageId"], "local-round-trip")
                    self.assertEqual(shared["station"]["telemetry"]["battery"]["soc"], 82.5)
                    self.assertEqual(shared["station"]["telemetry"]["solar"]["powerW"], 285)

                session_request = Request(
                    f"{base_url}/api/sessions",
                    data=json.dumps({
                        "portId": "outlet-2",
                        "portName": "Outlet 2",
                        "portType": "outlet",
                        "durationMinutes": 1,
                        "method": "Cash",
                    }).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urlopen(session_request, timeout=5) as response:
                    self.assertEqual(response.status, 201)

                with urlopen(request, timeout=5) as response:
                    active_command = json.load(response)["control"]
                    self.assertTrue(active_command["channels"]["outlet-2"]["relayOn"])
                    self.assertFalse(active_command["channels"]["outlet-1"]["relayOn"])

                stop_request = Request(
                    f"{base_url}/api/sessions",
                    data=json.dumps({"portId": "outlet-2"}).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="DELETE",
                )
                with urlopen(stop_request, timeout=5) as response:
                    self.assertEqual(response.status, 200)

                with urlopen(request, timeout=5) as response:
                    stopped_command = json.load(response)["control"]
                    self.assertEqual(stopped_command["commandId"], "relay:all-off")
                    self.assertFalse(stopped_command["channels"]["outlet-2"]["relayOn"])
            finally:
                httpd.shutdown()
                httpd.server_close()
                thread.join(timeout=5)
                server.STATE_FILE = original_state_file
                server.STATION_API_KEY = original_api_key


if __name__ == "__main__":
    unittest.main()
