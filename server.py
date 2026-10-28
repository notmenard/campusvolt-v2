"""CampusVolt local web server with shared charging-session state.

Run with: python server.py
Devices on the same network can then open the server's LAN address.  Session
changes are kept here instead of in one browser's localStorage, which lets all
connected dashboards see the same port availability.
"""

from __future__ import annotations

import argparse
import hmac
import json
import math
import mimetypes
import os
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse
from urllib.parse import parse_qs
from uuid import uuid4


ROOT = Path(__file__).resolve().parent
STATE_FILE = ROOT / ".campusvolt-state.json"
PORT_IDS = {
    "outlet-1",
    "outlet-2",
    "dc-type-c",
    "dc-micro-usb",
    "dc-lightning",
    "wireless-pad",
}
STATE_LOCK = threading.RLock()
HARDWARE_TTL_MS = 30_000
STATION_SCHEMA_VERSION = 1
STATION_ID = os.environ.get("CAMPUSVOLT_STATION_ID", "station-01")
STATION_API_KEY = os.environ.get("CAMPUSVOLT_STATION_API_KEY", "")
RELAY_COMMAND_LEASE_MS = 15_000
COIN_COLLECTION_TTL_MS = 300_000
ACCEPTED_COIN_DENOMINATIONS = {1, 5, 10}


def _bounded_number(value: object, minimum: float, maximum: float, field_name: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{field_name} must be a number from {minimum} to {maximum}.")
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field_name} must be a number from {minimum} to {maximum}.") from error
    if not math.isfinite(number) or number < minimum or number > maximum:
        raise ValueError(f"{field_name} must be a number from {minimum} to {maximum}.")
    return number


def _optional_number(value: object, minimum: float, maximum: float, field_name: str) -> float | None:
    return None if value is None else _bounded_number(value, minimum, maximum, field_name)


def _required_boolean(value: object, field_name: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{field_name} must be true or false.")
    return value


def _normalize_channel(source: object, port_id: str) -> dict:
    if not isinstance(source, dict):
        raise ValueError(f"channels.{port_id} must be an object.")
    return {
        # Compatibility field only. Paid sessions, not plug sensing, own availability.
        "inUse": _required_boolean(source.get("inUse"), f"channels.{port_id}.inUse")
        if "inUse" in source else False,
        "watts": _bounded_number(source.get("watts"), 0, 500, f"channels.{port_id}.watts"),
        "voltageV": _bounded_number(source.get("voltageV"), 0, 300, f"channels.{port_id}.voltageV"),
        "currentA": _bounded_number(source.get("currentA"), 0, 20, f"channels.{port_id}.currentA"),
        "relayOn": _required_boolean(source.get("relayOn"), f"channels.{port_id}.relayOn"),
        "fault": str(source.get("fault")).strip()[:80] if source.get("fault") else None,
    }


def _normalize_telemetry(source: object) -> dict | None:
    if source is None:
        return None
    if not isinstance(source, dict):
        raise ValueError("telemetry must be an object.")
    battery = source.get("battery")
    solar = source.get("solar")
    if not isinstance(battery, dict):
        raise ValueError("telemetry.battery must be an object.")
    if not isinstance(solar, dict):
        raise ValueError("telemetry.solar must be an object.")

    power_w = _bounded_number(battery.get("powerW"), -2000, 2000, "telemetry.battery.powerW")
    status = battery.get("status") or ("charging" if power_w > 5 else "discharging" if power_w < -5 else "idle")
    return {
        "battery": {
            "connected": _required_boolean(battery.get("connected"), "telemetry.battery.connected"),
            "soc": _bounded_number(battery.get("soc"), 0, 100, "telemetry.battery.soc"),
            "voltageV": _bounded_number(battery.get("voltageV"), 0, 100, "telemetry.battery.voltageV"),
            "currentA": _bounded_number(battery.get("currentA"), -200, 200, "telemetry.battery.currentA"),
            "powerW": power_w,
            "temperatureC": _bounded_number(battery.get("temperatureC"), -40, 120, "telemetry.battery.temperatureC"),
            "protection": str(battery.get("protection") or "unknown").strip()[:40],
            "status": str(status).strip()[:40],
            "ratedCapacityAh": _optional_number(battery.get("ratedCapacityAh"), 1, 2000, "telemetry.battery.ratedCapacityAh"),
            "ratedEnergyWh": _optional_number(battery.get("ratedEnergyWh"), 1, 100000, "telemetry.battery.ratedEnergyWh"),
            "remainingAh": _optional_number(battery.get("remainingAh"), 0, 2000, "telemetry.battery.remainingAh"),
            "remainingEnergyWh": _optional_number(battery.get("remainingEnergyWh"), 0, 100000, "telemetry.battery.remainingEnergyWh"),
            "healthPercent": _optional_number(battery.get("healthPercent"), 0, 100, "telemetry.battery.healthPercent"),
            "cycleCount": _optional_number(battery.get("cycleCount"), 0, 1000000, "telemetry.battery.cycleCount"),
            "cellMinVoltageV": _optional_number(battery.get("cellMinVoltageV"), 0, 6, "telemetry.battery.cellMinVoltageV"),
            "cellMaxVoltageV": _optional_number(battery.get("cellMaxVoltageV"), 0, 6, "telemetry.battery.cellMaxVoltageV"),
            "cellDeltaMv": _optional_number(battery.get("cellDeltaMv"), 0, 6000, "telemetry.battery.cellDeltaMv"),
        },
        "solar": {
            "powerW": _bounded_number(solar.get("powerW"), 0, 5000, "telemetry.solar.powerW"),
            "energyTodayWh": _optional_number(solar.get("energyTodayWh"), 0, 1000000, "telemetry.solar.energyTodayWh"),
            "peakPowerW": _optional_number(solar.get("peakPowerW"), 0, 5000, "telemetry.solar.peakPowerW"),
            "panelVoltageV": _optional_number(solar.get("panelVoltageV"), 0, 200, "telemetry.solar.panelVoltageV"),
            "controllerState": str(solar.get("controllerState") or "unknown").strip()[:40],
        },
    }


def _load_state() -> dict:
    try:
        payload = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _save_state(payload: dict) -> None:
    temporary = STATE_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    temporary.replace(STATE_FILE)


def _load_sessions() -> list[dict]:
    sessions = _load_state().get("sessions", [])
    return sessions if isinstance(sessions, list) else []


def _save_sessions(sessions: list[dict]) -> None:
    payload = _load_state()
    payload["sessions"] = sessions
    _save_state(payload)


def _coin_collection() -> dict | None:
    collection = _load_state().get("coinCollection")
    if not isinstance(collection, dict):
        return None
    if int(collection.get("expiresAt", 0)) <= int(time.time() * 1000):
        payload = _load_state()
        payload.pop("coinCollection", None)
        _save_state(payload)
        return None
    return collection


def _save_coin_collection(collection: dict | None) -> None:
    payload = _load_state()
    if collection is None:
        payload.pop("coinCollection", None)
    else:
        payload["coinCollection"] = collection
    _save_state(payload)


def _public_coin_collection(collection: dict | None) -> dict | None:
    if not collection or int(collection.get("expiresAt", 0)) <= int(time.time() * 1000):
        return None
    return {
        "collectionId": str(collection.get("collectionId", ""))[:80],
        "portId": collection.get("portId") if collection.get("portId") in PORT_IDS else None,
        "targetAmount": max(1, min(120, int(collection.get("targetAmount", 1)))),
        "insertedAmount": max(0, min(120, int(collection.get("insertedAmount", 0)))),
        "eventCount": max(0, int(collection.get("eventCount", 0))),
        "status": collection.get("status") if collection.get("status") in {"collecting", "ready", "consumed"} else "collecting",
        "createdAt": collection.get("createdAt"),
        "updatedAt": collection.get("updatedAt"),
        "expiresAt": int(collection.get("expiresAt", 0)),
        "lastCoinAt": collection.get("lastCoinAt"),
    }


def _build_coin_control(collection: dict | None, issued_at: int | None = None) -> dict:
    issued_at = issued_at if issued_at is not None else int(time.time() * 1000)
    current = _public_coin_collection(collection)
    enabled = bool(
        current
        and current["status"] == "collecting"
        and current["insertedAmount"] < current["targetAmount"]
        and current["expiresAt"] > issued_at
    )
    return {
        "schemaVersion": 1,
        "enabled": enabled,
        "collectionId": current["collectionId"] if current else None,
        "portId": current["portId"] if current else None,
        "targetAmount": current["targetAmount"] if current else 0,
        "insertedAmount": current["insertedAmount"] if current else 0,
        "acceptedDenominations": sorted(ACCEPTED_COIN_DENOMINATIONS),
        "validUntil": min(current["expiresAt"], issued_at + RELAY_COMMAND_LEASE_MS)
        if enabled else issued_at + RELAY_COMMAND_LEASE_MS,
    }


def _active_sessions() -> list[dict]:
    now_ms = int(time.time() * 1000)
    sessions = _load_sessions()
    active = [
        session
        for session in sessions
        if session.get("portId") in PORT_IDS
        and int(session.get("endTime", 0)) > now_ms
    ]
    if len(active) != len(sessions):
        _save_sessions(active)
    return active


def _build_relay_control(sessions: list[dict], issued_at: int | None = None) -> dict:
    issued_at = issued_at if issued_at is not None else int(time.time() * 1000)
    active_by_port = {
        session["portId"]: session
        for session in sessions
        if session.get("portId") in PORT_IDS and int(session.get("endTime", 0)) > issued_at
    }
    fingerprint = ",".join(
        f"{port_id}@{int(active_by_port[port_id]['endTime'])}"
        for port_id in sorted(active_by_port)
    ) or "all-off"
    valid_until = issued_at + RELAY_COMMAND_LEASE_MS
    return {
        "schemaVersion": 1,
        "commandId": f"relay:{fingerprint}",
        "issuedAt": issued_at,
        "validUntil": valid_until,
        "channels": {
            port_id: {
                "relayOn": port_id in active_by_port,
                "authorizedUntil": min(int(active_by_port[port_id]["endTime"]), valid_until)
                if port_id in active_by_port else None,
            }
            for port_id in PORT_IDS
        },
    }


def _hardware_status() -> dict:
    hardware = _load_state().get("hardware", {})
    updated_at = int(hardware.get("updatedAt", 0)) if isinstance(hardware, dict) else 0
    online = bool(updated_at and int(time.time() * 1000) - updated_at <= HARDWARE_TTL_MS)
    channels = {}
    for port_id in PORT_IDS:
        source = hardware.get("channels", {}).get(port_id, {}) if online else {}
        channels[port_id] = {
            "inUse": bool(source.get("inUse", False)),
            "watts": max(0, float(source.get("watts", 0) or 0)),
            "voltageV": max(0, float(source.get("voltageV", 0) or 0)),
            "currentA": max(0, float(source.get("currentA", 0) or 0)),
            "relayOn": bool(source.get("relayOn", False)),
            "fault": str(source.get("fault"))[:80] if source.get("fault") else None,
        }
    return {
        "online": online,
        "schemaVersion": int(hardware.get("schemaVersion", 1)) if online else None,
        "stationId": STATION_ID,
        "messageId": str(hardware.get("messageId", ""))[:80] or None if online else None,
        "sentAt": hardware.get("sentAt") if online else None,
        "updatedAt": updated_at if online else None,
        "latencyMs": max(0, updated_at - int(hardware["sentAt"]))
        if online and hardware.get("sentAt") is not None else None,
        "firmwareVersion": str(hardware.get("firmwareVersion", "unknown"))[:40] if online else None,
        "lastAppliedCommandId": str(hardware.get("lastAppliedCommandId", ""))[:256] or None if online else None,
        "rssi": hardware.get("rssi") if online else None,
        "channels": channels,
        "telemetry": hardware.get("telemetry") if online and isinstance(hardware.get("telemetry"), dict) else None,
    }


def _save_hardware(hardware: dict) -> None:
    payload = _load_state()
    payload["hardware"] = hardware
    _save_state(payload)


class CampusVoltHandler(SimpleHTTPRequestHandler):
    server_version = "CampusVolt/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        if self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        elif Path(urlparse(self.path).path).suffix in {".html", ".js", ".css"}:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 16_384:
            raise ValueError("Invalid request body")
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("JSON object required")
        return payload

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/sessions":
            with STATE_LOCK:
                self._send_json(
                    HTTPStatus.OK,
                    {"stationId": STATION_ID, "sessions": _active_sessions(), "station": _hardware_status()},
                )
            return
        if parsed.path == "/api/coin-collections":
            requested_id = parse_qs(parsed.query).get("collectionId", [""])[0]
            with STATE_LOCK:
                collection = _public_coin_collection(_coin_collection())
                if not collection or (requested_id and collection["collectionId"] != requested_id):
                    self._send_json(HTTPStatus.NOT_FOUND, {"error": "Coin collection not found or expired."})
                else:
                    self._send_json(HTTPStatus.OK, {"stationId": STATION_ID, "collection": collection})
            return
        super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/station-status":
            self._handle_station_status()
            return
        if path == "/api/station-coins":
            self._handle_station_coin()
            return
        if path == "/api/coin-collections":
            self._handle_coin_collection_create()
            return
        if path != "/api/sessions":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        try:
            request = self._read_json()
            port_id = str(request.get("portId", ""))
            duration = int(request.get("durationMinutes", 0))
            if port_id not in PORT_IDS or not 1 <= duration <= 120:
                raise ValueError("Invalid port or duration")
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return

        with STATE_LOCK:
            sessions = _active_sessions()
            hardware_channel = _hardware_status()["channels"].get(port_id, {})
            if hardware_channel.get("fault"):
                self._send_json(
                    HTTPStatus.CONFLICT,
                    {"error": "Station reports a fault on this channel.", "sessions": sessions, "station": _hardware_status()},
                )
                return
            if any(session["portId"] == port_id for session in sessions):
                self._send_json(
                    HTTPStatus.CONFLICT,
                    {"error": "That port is already in use.", "sessions": sessions},
                )
                return

            collection_id = str(request.get("collectionId") or "")
            payment_method = str(request.get("method", "Cash"))[:20]
            if payment_method.lower() == "gcash":
                self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "GCash payments are temporarily unavailable."})
                return
            pending_collection = _public_coin_collection(_coin_collection())
            if pending_collection and pending_collection["portId"] == port_id and pending_collection["collectionId"] != collection_id:
                self._send_json(HTTPStatus.CONFLICT, {"error": "That channel is reserved by an active cash payment."})
                return
            if payment_method == "Cash" and not collection_id:
                self._send_json(HTTPStatus.PAYMENT_REQUIRED, {"error": "Cash sessions require a completed physical coin collection."})
                return
            if collection_id:
                collection = _public_coin_collection(_coin_collection())
                if not collection or collection["collectionId"] != collection_id or collection["portId"] != port_id:
                    self._send_json(HTTPStatus.CONFLICT, {"error": "The physical coin collection is missing, expired, or belongs to another channel."})
                    return
                if collection["status"] != "ready" or collection["insertedAmount"] < collection["targetAmount"]:
                    self._send_json(HTTPStatus.CONFLICT, {"error": "The selected coin amount has not been fully inserted."})
                    return
                duration = collection["insertedAmount"]

            now_ms = int(time.time() * 1000)
            watts = 10 if port_id == "wireless-pad" else 9
            session = {
                "portId": port_id,
                "portName": str(request.get("portName", port_id)),
                "portType": str(request.get("portType", "outlet")),
                "spec": str(request.get("spec", "")),
                "device": str(request.get("device", "Phone")),
                "watts": watts,
                "paid": f"PHP {duration} - {payment_method}",
                "durationMinutes": duration,
                "totalSeconds": duration * 60,
                "remainingSeconds": duration * 60,
                "cost": float(duration),
                "startTime": now_ms,
                "endTime": now_ms + duration * 60_000,
                "energyKWh": 0.0,
            }
            sessions.append(session)
            _save_sessions(sessions)
            if collection_id:
                _save_coin_collection(None)
            self._send_json(HTTPStatus.CREATED, {"session": session, "sessions": sessions})

    def _handle_coin_collection_create(self) -> None:
        try:
            request = self._read_json()
            port_id = str(request.get("portId", ""))
            target_amount = int(request.get("targetAmount", 0))
            if port_id not in PORT_IDS or not 1 <= target_amount <= 120:
                raise ValueError("Select a valid channel and a coin target from PHP 1 to PHP 120.")
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return

        with STATE_LOCK:
            if not _hardware_status()["online"]:
                self._send_json(HTTPStatus.CONFLICT, {"error": "The ESP32 station is offline, so the coin acceptor cannot be enabled."})
                return
            if _coin_collection():
                self._send_json(HTTPStatus.CONFLICT, {
                    "error": "Another customer is already using the shared coin acceptor.",
                    "collection": _public_coin_collection(_coin_collection()),
                })
                return
            if any(session["portId"] == port_id for session in _active_sessions()):
                self._send_json(HTTPStatus.CONFLICT, {"error": "That channel already has an active charging session."})
                return
            if _hardware_status()["channels"].get(port_id, {}).get("fault"):
                self._send_json(HTTPStatus.CONFLICT, {"error": "The station reports a fault on that channel."})
                return

            now_ms = int(time.time() * 1000)
            collection = {
                "collectionId": f"coins-{uuid4()}",
                "portId": port_id,
                "targetAmount": target_amount,
                "insertedAmount": 0,
                "eventCount": 0,
                "status": "collecting",
                "createdAt": now_ms,
                "updatedAt": now_ms,
                "expiresAt": now_ms + COIN_COLLECTION_TTL_MS,
                "lastCoinAt": None,
            }
            _save_coin_collection(collection)
            self._send_json(HTTPStatus.CREATED, {"stationId": STATION_ID, "collection": collection})

    def _handle_station_coin(self) -> None:
        if not STATION_API_KEY:
            self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "CAMPUSVOLT_STATION_API_KEY is not configured."})
            return
        authorization = self.headers.get("Authorization", "")
        bearer = authorization[7:] if authorization.startswith("Bearer ") else ""
        supplied_key = self.headers.get("X-CampusVolt-Key", "") or bearer
        if not supplied_key or not hmac.compare_digest(supplied_key, STATION_API_KEY):
            self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "Invalid station credentials."})
            return

        try:
            request = self._read_json()
            collection_id = str(request.get("collectionId") or "")[:80]
            event_id = str(request.get("eventId") or "")[:100]
            denomination = int(request.get("denomination", 0))
            pulse_count = int(request.get("pulseCount", 0))
            if not collection_id or not event_id or denomination not in ACCEPTED_COIN_DENOMINATIONS:
                raise ValueError("A valid collection, event ID, and denomination are required.")
            if not 1 <= pulse_count <= 100:
                raise ValueError("pulseCount must be from 1 to 100.")
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return

        with STATE_LOCK:
            payload = _load_state()
            events = payload.get("coinEvents", {}) if isinstance(payload.get("coinEvents"), dict) else {}
            collection = _public_coin_collection(_coin_collection())
            if not collection:
                self._send_json(HTTPStatus.GONE, {"error": "Coin collection has expired."})
                return
            if collection["collectionId"] != collection_id:
                self._send_json(HTTPStatus.CONFLICT, {"error": "Coin event does not match the active collection."})
                return
            if event_id in events:
                self._send_json(HTTPStatus.OK, {
                    "accepted": True,
                    "duplicate": True,
                    "stationId": STATION_ID,
                    "collection": collection,
                })
                return
            if collection["status"] not in {"collecting", "ready"}:
                self._send_json(HTTPStatus.CONFLICT, {"error": "Coin collection is no longer accepting coins."})
                return

            now_ms = int(time.time() * 1000)
            collection["insertedAmount"] = min(120, collection["insertedAmount"] + denomination)
            collection["eventCount"] += 1
            collection["updatedAt"] = now_ms
            collection["lastCoinAt"] = now_ms
            if collection["insertedAmount"] >= collection["targetAmount"]:
                collection["status"] = "ready"
            events[event_id] = now_ms
            events = {key: value for key, value in events.items() if now_ms - int(value) <= 600_000}
            payload["coinCollection"] = collection
            payload["coinEvents"] = events
            _save_state(payload)
            self._send_json(HTTPStatus.ACCEPTED, {
                "accepted": True,
                "duplicate": False,
                "stationId": STATION_ID,
                "collection": collection,
            })

    def _handle_station_status(self) -> None:
        if not STATION_API_KEY:
            self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "CAMPUSVOLT_STATION_API_KEY is not configured."})
            return
        authorization = self.headers.get("Authorization", "")
        bearer = authorization[7:] if authorization.startswith("Bearer ") else ""
        supplied_key = self.headers.get("X-CampusVolt-Key", "") or bearer
        if not supplied_key or not hmac.compare_digest(supplied_key, STATION_API_KEY):
            self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "Invalid station credentials."})
            return

        try:
            request = self._read_json()
            if request.get("stationId") and str(request["stationId"]) != STATION_ID:
                self._send_json(HTTPStatus.CONFLICT, {"error": f"This endpoint is configured for {STATION_ID}."})
                return
            if request.get("schemaVersion") is not None and int(request["schemaVersion"]) != STATION_SCHEMA_VERSION:
                raise ValueError(f"schemaVersion must be {STATION_SCHEMA_VERSION}.")
            supplied_channels = request.get("channels")
            if not isinstance(supplied_channels, dict):
                raise ValueError("channels must be an object containing all six channel IDs.")
            channels = {}
            for port_id in PORT_IDS:
                if port_id not in supplied_channels:
                    raise ValueError(f"channels.{port_id} is required.")
                channels[port_id] = _normalize_channel(supplied_channels[port_id], port_id)
            telemetry = _normalize_telemetry(request.get("telemetry"))
            sent_at = _optional_number(request.get("sentAt"), 0, 9_007_199_254_740_991, "sentAt")
            rssi = _optional_number(request.get("rssi"), -120, 0, "rssi")
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return

        received_at = int(time.time() * 1000)
        hardware = {
            "schemaVersion": STATION_SCHEMA_VERSION,
            "stationId": STATION_ID,
            "messageId": str(request.get("messageId") or f"{STATION_ID}-{received_at}").strip()[:80],
            "sentAt": sent_at,
            "updatedAt": received_at,
            "firmwareVersion": str(request.get("firmwareVersion", "unknown"))[:40],
            "lastAppliedCommandId": str(request.get("lastAppliedCommandId") or "").strip()[:256] or None,
            "rssi": rssi,
            "channels": channels,
            "telemetry": telemetry,
        }
        with STATE_LOCK:
            _save_hardware(hardware)
            active_sessions = _active_sessions()
            station = _hardware_status()
        self._send_json(
            HTTPStatus.ACCEPTED,
            {
                "accepted": True,
                "heartbeatTtlSeconds": HARDWARE_TTL_MS // 1000,
                "station": station,
                "control": _build_relay_control(active_sessions, received_at),
                "coinControl": _build_coin_control(_coin_collection(), received_at),
            },
        )

    def do_DELETE(self) -> None:
        path = unquote(urlparse(self.path).path)
        if path == "/api/coin-collections":
            try:
                collection_id = str(self._read_json().get("collectionId", ""))
            except (ValueError, TypeError, json.JSONDecodeError) as error:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            with STATE_LOCK:
                collection = _public_coin_collection(_coin_collection())
                if not collection or collection["collectionId"] != collection_id:
                    self._send_json(HTTPStatus.NOT_FOUND, {"error": "Coin collection not found or expired."})
                elif collection["insertedAmount"] > 0:
                    self._send_json(HTTPStatus.CONFLICT, {"error": "A collection containing physical coins cannot be cancelled."})
                else:
                    _save_coin_collection(None)
                    self._send_json(HTTPStatus.OK, {"stationId": STATION_ID, "cancelled": collection_id})
            return
        if path == "/api/sessions":
            try:
                port_id = str(self._read_json().get("portId", ""))
            except (ValueError, TypeError, json.JSONDecodeError) as error:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
        elif path.startswith("/api/sessions/"):
            port_id = path[len("/api/sessions/") :]
        else:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if port_id not in PORT_IDS:
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Port not found"})
            return

        with STATE_LOCK:
            sessions = _active_sessions()
            updated = [session for session in sessions if session["portId"] != port_id]
            _save_sessions(updated)
            self._send_json(HTTPStatus.OK, {"sessions": updated})

    def log_message(self, message: str, *args) -> None:
        print(f"{self.address_string()} - {message % args}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the CampusVolt dashboard")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=5500)
    args = parser.parse_args()

    mimetypes.add_type("text/javascript", ".js")
    server = ThreadingHTTPServer((args.host, args.port), CampusVoltHandler)
    print(f"CampusVolt is running on http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
