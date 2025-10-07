#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NKN Elevation Forwarder — single-file, venv-bootstrapped, with NKN MultiClient sidecar.

Flow
----
- Python (Flask) <-> Node sidecar (nkn-sdk-js MultiClient) via NDJSON over stdio.
- Incoming DM payloads:
    { "id": "...", "type": "elev.query", "locations":[{"lat":..,"lng":..},...], "dataset":"mapzen" }
  or the generic form:
    { "id": "...", "type": "http.request", "method":"GET", "url":"/v1/mapzen?locations=56,123" }
- The forwarder calls local OpenTopo: http://localhost:5000/v1/<dataset>?locations=...
- Sends DM back:
    { "id": "...", "type":"http.response", "status":200, "headers":{...}, "body_b64":"...", "duration_ms":N }

HTTP endpoints
--------------
GET  /healthz
POST /forward   -> {dest, locations:[{lat,lng},...], dataset?}  (builds elev.query to DM peer; waits for DM reply)
"""

from __future__ import annotations
import os, sys, subprocess, json, time, uuid, threading, base64, shutil, socket, ssl, re, math
from pathlib import Path
from typing import Any, Dict, Optional
from datetime import datetime, timezone, timedelta
from collections import deque

# ─────────────────────────────────────────────────────────────────────────────
# 0) Minimal re-exec into a local venv (create once, then fast-start)
# ─────────────────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
VENV_DIR   = SCRIPT_DIR / ".venv"
SETUP_MKR  = SCRIPT_DIR / ".forwarder_setup_complete"

def _in_venv() -> bool:
    base = getattr(sys, "base_prefix", None)
    return base is not None and sys.prefix != base

def _ensure_venv_and_reexec():
    if sys.version_info < (3, 9):
        print("ERROR: Python 3.9+ required.", file=sys.stderr); sys.exit(1)
    if not _in_venv():
        py = sys.executable
        if not VENV_DIR.exists():
            print(f"[PROCESS] Creating virtualenv at {VENV_DIR}…", flush=True)
            subprocess.check_call([py, "-m", "venv", str(VENV_DIR)])
            pip_bin = str(VENV_DIR / ("Scripts/pip.exe" if os.name == "nt" else "bin/pip"))
            subprocess.check_call([pip_bin, "install", "--upgrade", "pip"])
        py_bin = str(VENV_DIR / ("Scripts/python.exe" if os.name == "nt" else "bin/python"))
        env = os.environ.copy()
        env["VIRTUAL_ENV"] = str(VENV_DIR)
        if os.name != "nt":
            env["PATH"] = f"{VENV_DIR}/bin:{env.get('PATH','')}"
        os.execve(py_bin, [py_bin] + sys.argv, env)

_ensure_venv_and_reexec()

# ─────────────────────────────────────────────────────────────────────────────
# 1) First-run pip deps + .env + Node sidecar (nkn-sdk)
# ─────────────────────────────────────────────────────────────────────────────
def _pip(*pkgs): subprocess.check_call([sys.executable, "-m", "pip", "install", *pkgs])

if not SETUP_MKR.exists():
    print("[PROCESS] Installing Python dependencies…", flush=True)
    _pip("--upgrade", "pip")
    _pip("flask", "flask-cors", "python-dotenv", "requests", "waitress", "cryptography")
    # Write default .env
    env_path = SCRIPT_DIR / ".env"
    if not env_path.exists():
        env_path.write_text(
            "FORWARD_BIND=0.0.0.0\n"
            "FORWARD_PORT=9011\n"
            "FORWARD_FORCE_LOCAL=0\n"
            "FORWARD_CONCURRENCY=16\n"
            "FORWARD_RATE_RPS=20\n"
            "FORWARD_RATE_BURST=40\n"
            "\n"
            "# TLS: 0|1|adhoc|generate|mkcert\n"
            "FORWARD_SSL=0\n"
            "FORWARD_SSL_CERT=tls/cert.pem\n"
            "FORWARD_SSL_KEY=tls/key.pem\n"
            "FORWARD_SSL_REFRESH=0\n"
            "FORWARD_SSL_EXTRA_DNS_SANS=\n"
            "\n"
            "# OpenTopo local service\n"
            "ELEV_BASE=http://localhost:5000\n"
            "ELEV_DATASET=mapzen\n"
            "ELEV_TIMEOUT_MS=10000\n"
            "\n"
            "# NKN MultiClient sidecar settings\n"
            "NKN_IDENTIFIER=forwarder\n"
            "NKN_SEED=\n"
            "NKN_SUBCLIENTS=4\n"
            "NKN_RPC_ADDRS=\n"
        )
        print("[SUCCESS] Wrote .env with defaults.", flush=True)
    # Sidecar files
    SIDE_DIR = SCRIPT_DIR / "sidecar"
    SIDE_DIR.mkdir(parents=True, exist_ok=True)
    (SIDE_DIR / ".gitignore").write_text("node_modules/\npackage-lock.json\n")
    pkg = SIDE_DIR / "package.json"
    if not pkg.exists():
        subprocess.check_call(["npm", "init", "-y"], cwd=str(SIDE_DIR))
    # Write sidecar.js
    (SIDE_DIR / "sidecar.js").write_text(r"""
/* NKN sidecar: NDJSON over stdio.
   Env:
   - NKN_IDENTIFIER
   - NKN_SEED (optional; empty = random)
   - NKN_SUBCLIENTS (int)
   - NKN_RPC_ADDRS (comma-separated)
*/
const readline = require('readline');
const { MultiClient } = require('nkn-sdk');

function ndj(obj){ try{ process.stdout.write(JSON.stringify(obj)+"\n"); }catch{} }

(async () => {
  const identifier = (process.env.NKN_IDENTIFIER || 'forwarder').trim();
  const seed = (process.env.NKN_SEED || '').trim() || undefined;
  const numSubClients = Math.max(1, parseInt(process.env.NKN_SUBCLIENTS || '4', 10));
  const rpcStr = (process.env.NKN_RPC_ADDRS || '').trim();
  const rpcServerAddr = rpcStr ? rpcStr.split(',').map(s=>s.trim()).filter(Boolean) : undefined;

  let mc;
  try {
    mc = new MultiClient({ identifier, seed, numSubClients, originalClient: false, rpcServerAddr });
  } catch (e) {
    ndj({ ev:"error", message: String(e && e.message || e) });
    process.exit(1);
  }

  mc.onConnect(() => ndj({ ev:"ready", addr: mc.addr }));
  mc.onMessage(({ src, payload }) => {
    try {
      const buf = (typeof payload === 'string') ? Buffer.from(payload) : Buffer.from(payload);
      ndj({ ev:"message", src, payload_b64: buf.toString('base64') });
    } catch (e) {
      ndj({ ev:"error", message: "onMessage decode: "+(e && e.message || e) });
    }
  });

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.op === 'send') {
      try {
        const dest = String(msg.dest || '').trim();
        if (!dest) return ndj({ ev:"error", message:"missing dest", id: msg.id });
        const data = msg.payload_b64 ? Buffer.from(msg.payload_b64, 'base64') : Buffer.alloc(0);
        await mc.send(dest, data);
        ndj({ ev:"sent", id: msg.id, dest });
      } catch (e) {
        ndj({ ev:"error", id: msg.id, message: String(e && e.message || e) });
      }
    } else if (msg.op === 'close') {
      try { await mc.close(); } catch {}
      process.exit(0);
    }
  });

  process.on('SIGINT', async ()=>{ try{ await mc.close(); }catch{} process.exit(0); });
  process.on('SIGTERM', async ()=>{ try{ await mc.close(); }catch{} process.exit(0); });
})();
""")
    print("[PROCESS] Installing Node sidecar dependency (nkn-sdk)…", flush=True)
    subprocess.check_call(["npm", "install", "nkn-sdk@latest", "--no-fund", "--silent"], cwd=str(SIDE_DIR))
    SETUP_MKR.write_text("ok")
    print("[SUCCESS] Setup complete. Restarting…", flush=True)
    os.execv(sys.executable, [sys.executable] + sys.argv)

# ─────────────────────────────────────────────────────────────────────────────
# 2) Runtime deps & env
# ─────────────────────────────────────────────────────────────────────────────
from flask import Flask, request, jsonify, Response
from flask_cors import CORS
from dotenv import load_dotenv
import requests

load_dotenv(SCRIPT_DIR / ".env")

FORWARD_BIND        = os.getenv("FORWARD_BIND", "0.0.0.0")
FORWARD_PORT        = int(os.getenv("FORWARD_PORT", "9011"))
FORWARD_FORCE_LOCAL = os.getenv("FORWARD_FORCE_LOCAL", "0") == "1"
FORWARD_CONCURRENCY = max(1, int(os.getenv("FORWARD_CONCURRENCY", "16")))
FORWARD_RATE_RPS    = max(1, int(os.getenv("FORWARD_RATE_RPS", "20")))
FORWARD_RATE_BURST  = max(1, int(os.getenv("FORWARD_RATE_BURST", "40")))

FORWARD_SSL_MODE    = (os.getenv("FORWARD_SSL", "0") or "0").lower()
FORWARD_SSL_CERT    = os.getenv("FORWARD_SSL_CERT", "tls/cert.pem")
FORWARD_SSL_KEY     = os.getenv("FORWARD_SSL_KEY",  "tls/key.pem")
FORWARD_SSL_REFRESH = os.getenv("FORWARD_SSL_REFRESH","0") == "1"
FORWARD_SSL_SANS    = [s.strip() for s in os.getenv("FORWARD_SSL_EXTRA_DNS_SANS","").split(",") if s.strip()]

ELEV_BASE           = os.getenv("ELEV_BASE", "http://localhost:5000").rstrip("/")
ELEV_DATASET        = os.getenv("ELEV_DATASET", "mapzen")
ELEV_TIMEOUT_MS     = int(os.getenv("ELEV_TIMEOUT_MS", "10000"))

NKN_IDENTIFIER      = os.getenv("NKN_IDENTIFIER", "forwarder")
NKN_SEED            = os.getenv("NKN_SEED", "").strip()
NKN_SUBCLIENTS      = max(1, int(os.getenv("NKN_SUBCLIENTS", "4")))
NKN_RPC_ADDRS       = [s.strip() for s in os.getenv("NKN_RPC_ADDRS","").split(",") if s.strip()]

TLS_DIR             = SCRIPT_DIR / "tls"
TLS_DIR.mkdir(exist_ok=True, parents=True)

class ForwarderMetrics:
    def __init__(self):
        self.lock = threading.Lock()
        now = time.time()
        self.started_at = now
        self.forward_total = 0
        self.forward_success = 0
        self.forward_failure = 0
        self.forward_timeouts = 0
        self.forward_inflight = 0
        self.forward_max_inflight = 0
        self.forward_last_status = None
        self.forward_last_duration_ms = None
        self.forward_duration_samples = deque(maxlen=200)
        self.forward_duration_sum = 0.0
        self.last_forward_at = None
        self.last_forward_success_at = None
        self.last_forward_error_at = None
        self.last_forward_error = None
        self.dm_total = 0
        self.dm_health = 0
        self.dm_query = 0
        self.dm_invalid = 0
        self.last_health_at = None
        self.last_health_payload = None
        self.sidecar_errors = 0
        self.last_sidecar_error = None
        self.last_sidecar_error_at = None

    def start_forward(self):
        with self.lock:
            self.forward_total += 1
            self.forward_inflight += 1
            if self.forward_inflight > self.forward_max_inflight:
                self.forward_max_inflight = self.forward_inflight
            self.last_forward_at = time.time()

    def finish_forward(self, duration_ms: float, ok: bool, status: Optional[int] = None, error: Optional[Exception] = None):
        now = time.time()
        with self.lock:
            self.forward_inflight = max(0, self.forward_inflight - 1)
            if duration_ms is not None:
                clamped = max(0.0, float(duration_ms))
                self.forward_last_duration_ms = clamped
                self.forward_duration_samples.append(clamped)
                self.forward_duration_sum += clamped
            if status is not None:
                self.forward_last_status = int(status)
            if ok:
                self.forward_success += 1
                self.last_forward_success_at = now
            else:
                self.forward_failure += 1
                if error:
                    msg = str(error)
                    self.last_forward_error = msg
                    if 'timeout' in msg.lower():
                        self.forward_timeouts += 1
                else:
                    self.last_forward_error = None
                self.last_forward_error_at = now

    def record_dm(self, kind: str, ok: bool = True):
        with self.lock:
            self.dm_total += 1
            if kind == 'health':
                self.dm_health += 1
                self.last_health_at = time.time()
            elif kind == 'query':
                if ok:
                    self.dm_query += 1
                else:
                    self.dm_invalid += 1
            elif not ok:
                self.dm_invalid += 1

    def record_health_payload(self, payload: Dict[str, Any]):
        with self.lock:
            self.last_health_payload = payload
            self.last_health_at = time.time()

    def note_sidecar_error(self, message: str):
        with self.lock:
            self.sidecar_errors += 1
            self.last_sidecar_error = message
            self.last_sidecar_error_at = time.time()

    def snapshot(self) -> Dict[str, Any]:
        now = time.time()
        with self.lock:
            durations = list(self.forward_duration_samples)
            avg_ms = (sum(durations) / len(durations)) if durations else 0.0
            p95_ms = 0.0
            if durations:
                ordered = sorted(durations)
                idx = min(len(ordered) - 1, max(0, int(math.ceil(len(ordered) * 0.95)) - 1))
                p95_ms = ordered[idx]
            return {
                "uptime_s": round(now - self.started_at, 3),
                "forward": {
                    "total": self.forward_total,
                    "success": self.forward_success,
                    "failure": self.forward_failure,
                    "timeouts": self.forward_timeouts,
                    "inflight": self.forward_inflight,
                    "max_inflight": self.forward_max_inflight,
                    "avg_ms": round(avg_ms, 3),
                    "p95_ms": round(p95_ms, 3),
                    "last_duration_ms": self.forward_last_duration_ms,
                    "last_status": self.forward_last_status,
                    "last_request_ts": int(self.last_forward_at * 1000) if self.last_forward_at else None,
                    "last_success_ts": int(self.last_forward_success_at * 1000) if self.last_forward_success_at else None,
                    "last_error": self.last_forward_error,
                    "last_error_ts": int(self.last_forward_error_at * 1000) if self.last_forward_error_at else None,
                },
                "dm": {
                    "total": self.dm_total,
                    "health": self.dm_health,
                    "query": self.dm_query,
                    "invalid": self.dm_invalid,
                    "last_health_ts": int(self.last_health_at * 1000) if self.last_health_at else None,
                },
                "sidecar": {
                    "errors": self.sidecar_errors,
                    "last_error": self.last_sidecar_error,
                    "last_error_ts": int(self.last_sidecar_error_at * 1000) if self.last_sidecar_error_at else None,
                },
                "last_health_payload": self.last_health_payload,
            }

METRICS = ForwarderMetrics()

# ─────────────────────────────────────────────────────────────────────────────
# 3) Small logging, rate limit, semaphore
# ─────────────────────────────────────────────────────────────────────────────
CLR = {"RESET":"\033[0m","INFO":"\033[94m","SUCCESS":"\033[92m","WARN":"\033[93m","ERR":"\033[91m"}
def log(msg, cat="INFO"):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    c = CLR.get(cat, ""); e = CLR["RESET"] if c else ""
    print(f"{c}[{ts}] {cat}: {msg}{e}", flush=True)

from threading import Semaphore, Lock
_CONC = Semaphore(FORWARD_CONCURRENCY)
_rl_lock = Lock()
class _Bucket: __slots__=("ts","tokens")
_buckets: Dict[str,_Bucket] = {}

def _rate_ok(ip: str) -> bool:
    now = time.time()
    with _rl_lock:
        b = _buckets.get(ip)
        if b is None:
            b = _Bucket(); b.ts = now; b.tokens = float(FORWARD_RATE_BURST); _buckets[ip]=b
        dt = max(0.0, now - b.ts); b.ts = now
        b.tokens = min(float(FORWARD_RATE_BURST), b.tokens + dt*FORWARD_RATE_RPS)
        if b.tokens < 1.0:
            return False
        b.tokens -= 1.0
        return True

# ─────────────────────────────────────────────────────────────────────────────
# 4) NKN sidecar supervisor (Node process) — NDJSON bridge
# ─────────────────────────────────────────────────────────────────────────────
import threading, queue

SIDE_DIR = SCRIPT_DIR / "sidecar"
SIDECAR_JS = SIDE_DIR / "sidecar.js"

class Sidecar:
    def __init__(self):
        self.proc = None
        self.reader = None
        self.addr = None
        self.events = queue.Queue()   # (ev, data_dict)
        self.lock = threading.Lock()
    def start(self):
        if not shutil.which("node"):
            log("Node.js is required (not found on PATH).", "ERR"); sys.exit(1)
        env = os.environ.copy()
        env["NKN_IDENTIFIER"] = NKN_IDENTIFIER
        env["NKN_SEED"] = NKN_SEED
        env["NKN_SUBCLIENTS"] = str(NKN_SUBCLIENTS)
        if NKN_RPC_ADDRS:
            env["NKN_RPC_ADDRS"] = ",".join(NKN_RPC_ADDRS)
        self.proc = subprocess.Popen(
            ["node", str(SIDECAR_JS)],
            cwd=str(SIDE_DIR),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1, env=env
        )
        def _read():
            for line in self.proc.stdout:
                line = line.strip()
                if not line: continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                ev = obj.get("ev")
                if ev == "ready":
                    self.addr = obj.get("addr")
                    log(f"NKN sidecar ready: {self.addr}", "SUCCESS")
                self.events.put((ev, obj))
        self.reader = threading.Thread(target=_read, daemon=True, name="nkn-reader"); self.reader.start()
    def send(self, dest: str, payload_b64: str, msg_id: str):
        if not self.proc or not self.proc.stdin:
            raise RuntimeError("sidecar not running")
        cmd = {"op":"send", "id": msg_id, "dest": dest, "payload_b64": payload_b64}
        self.proc.stdin.write(json.dumps(cmd)+"\n"); self.proc.stdin.flush()
    def close(self):
        try:
            if self.proc and self.proc.stdin:
                self.proc.stdin.write(json.dumps({"op":"close"})+"\n"); self.proc.stdin.flush()
        except Exception: pass

sidecar = Sidecar()
sidecar.start()

# DM pending futures (for /forward)
import asyncio
_pending: Dict[str, asyncio.Future] = {}

# ─────────────────────────────────────────────────────────────────────────────
# 5) DM dispatcher thread: consume sidecar events
# ─────────────────────────────────────────────────────────────────────────────
def _now_ms() -> int: return int(time.time()*1000)

def _http_elev_query(locations: Any, dataset: Optional[str]) -> Dict[str, Any]:
    """Call http://localhost:5000/v1/<dataset>?locations=... and return dict with status, headers, body_b64, duration_ms"""
    if isinstance(locations, str):
        loc_q = locations.strip()
    elif isinstance(locations, list):
        # expect list of {lat,lng}
        pairs = []
        for p in locations:
            lat = p.get("lat"); lng = p.get("lng")
            pairs.append(f"{lat},{lng}")
        loc_q = "|".join(pairs)
    else:
        raise ValueError("locations must be string or list[{lat,lng}]")
    ds = (dataset or ELEV_DATASET).strip() or ELEV_DATASET
    url = f"{ELEV_BASE}/v1/{ds}?locations={requests.utils.quote(loc_q, safe='|,')}"
    t0 = _now_ms()
    METRICS.start_forward()
    status_code = None
    try:
        resp = requests.get(url, timeout=ELEV_TIMEOUT_MS/1000.0)
        dur = _now_ms() - t0
        status_code = resp.status_code
        body = resp.content or b""
        headers = {str(k): str(v) for k, v in resp.headers.items()}
        METRICS.finish_forward(dur, True, status=status_code)
        return {"status": resp.status_code, "headers": headers, "body_b64": base64.b64encode(body).decode(), "duration_ms": dur}
    except Exception as e:
        dur = _now_ms() - t0
        METRICS.finish_forward(dur, False, status=status_code, error=e)
        return {"status": 502, "headers": {"content-type":"application/json"}, "body_b64": base64.b64encode(json.dumps({"error": f"upstream failure: {e}"}).encode()).decode(), "duration_ms": dur}

def _handle_incoming_dm(src: str, payload_b64: str):
    try:
        raw = base64.b64decode(payload_b64) if payload_b64 else b""
        msg = json.loads(raw.decode("utf-8", "ignore") or "{}")
    except Exception:
        return
    t = str(msg.get("type","")).lower()
    mid = str(msg.get("id") or "")
    if t == "http.response" and mid:
        # fulfill pending /forward
        fut = _pending.pop(mid, None)
        if fut and not fut.done():
            fut.set_result(msg)
        return

    if t == "health":
        reply = {
            "id": mid or uuid.uuid4().hex,
            "type": "health.response",
            "status": "ok",
            "forwarder": sidecar.addr,
            "time": datetime.utcnow().isoformat() + "Z",
            "metrics": METRICS.snapshot(),
            "dm_pending": len(_pending),
        }
        METRICS.record_dm("health")
        METRICS.record_health_payload(reply)
        sidecar.send(src, base64.b64encode(json.dumps(reply).encode()).decode(), msg_id=mid or uuid.uuid4().hex)
        return

    if t in ("elev.query", "http.request"):
        # Forward to OpenTopo and reply to src with same id
        if t == "elev.query":
            dataset  = msg.get("dataset") or ELEV_DATASET
            locations = msg.get("locations")
            try:
                with _CONC:
                    resp = _http_elev_query(locations, dataset)
            except Exception as e:
                resp = {"status": 500, "headers":{"content-type":"application/json"},
                        "body_b64": base64.b64encode(json.dumps({"error": str(e)}).encode()).decode(),
                        "duration_ms": 0}
            reply = {"id": mid or uuid.uuid4().hex, "type":"http.response", **resp}
            METRICS.record_dm("query", ok=isinstance(resp.get("status"), int) and resp["status"] < 500)
            sidecar.send(src, base64.b64encode(json.dumps(reply).encode()).decode(), msg_id=mid or uuid.uuid4().hex)
            return

        if t == "http.request":
            # VERY limited support: only GET to /v1/<dataset>?locations=...
            method = str(msg.get("method","GET")).upper()
            url    = str(msg.get("url","")).strip()
            if method != "GET" or not url.startswith("/v1/"):
                METRICS.record_dm("query", ok=False)
                body = base64.b64encode(json.dumps({"error":"only GET /v1/<dataset>?locations=... supported"}).encode()).decode()
                sidecar.send(src, base64.b64encode(json.dumps({"id": mid or uuid.uuid4().hex, "type":"http.response", "status":400, "headers":{"content-type":"application/json"}, "body_b64": body, "duration_ms":0}).encode()).decode(), msg_id=mid or uuid.uuid4().hex)
                return
            # Extract dataset and locations; pass to OpenTopo
            m = re.match(r"^/v1/([^?]+)\?locations=(.+)$", url)
            if not m:
                METRICS.record_dm("query", ok=False)
                body = base64.b64encode(json.dumps({"error":"missing locations"}).encode()).decode()
                sidecar.send(src, base64.b64encode(json.dumps({"id": mid or uuid.uuid4().hex, "type":"http.response", "status":400, "headers":{"content-type":"application/json"}, "body_b64": body, "duration_ms":0}).encode()).decode(), msg_id=mid or uuid.uuid4().hex)
                return
            dataset = m.group(1)
            # locations may be URL-encoded already; send as-is to our _http_elev_query
            try:
                with _CONC:
                    resp = _http_elev_query(m.group(2), dataset)
            except Exception as e:
                resp = {"status": 500, "headers":{"content-type":"application/json"},
                        "body_b64": base64.b64encode(json.dumps({"error": str(e)}).encode()).decode(),
                        "duration_ms": 0}
            reply = {"id": mid or uuid.uuid4().hex, "type":"http.response", **resp}
            METRICS.record_dm("query", ok=isinstance(resp.get("status"), int) and resp["status"] < 500)
            sidecar.send(src, base64.b64encode(json.dumps(reply).encode()).decode(), msg_id=mid or uuid.uuid4().hex)
            return

# Reader loop thread
def _event_loop():
    while True:
        ev, obj = sidecar.events.get()
        if ev == "message":
            _handle_incoming_dm(obj.get("src"), obj.get("payload_b64") or "")
        elif ev == "error":
            log(f"Sidecar error: {obj.get('message')}", "ERR")
            METRICS.note_sidecar_error(str(obj.get("message")))
        elif ev == "ready":
            log(f"My NKN address: {obj.get('addr')}", "INFO")

threading.Thread(target=_event_loop, daemon=True, name="nkn-dispatch").start()

# ─────────────────────────────────────────────────────────────────────────────
# 6) Flask HTTP API
# ─────────────────────────────────────────────────────────────────────────────
from werkzeug.serving import make_server, generate_adhoc_ssl_context
from werkzeug.serving import BaseWSGIServer
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import rsa
import cryptography.x509 as x509
from cryptography.x509 import NameOID, SubjectAlternativeName, DNSName, IPAddress
import ipaddress as ipa
import atexit, signal as _sig

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

@app.before_request
def _rate_guard():
    ip = request.headers.get("X-Forwarded-For","").split(",")[0].strip() or request.remote_addr or "0.0.0.0"
    if not _rate_ok(ip):
        return jsonify({"error":"rate limit"}), 429, {"Retry-After":"1"}

@app.get("/healthz")
def healthz():
    return jsonify({
        "ok": True, "addr": sidecar.addr, "elev_base": ELEV_BASE, "dataset": ELEV_DATASET,
        "ts": int(time.time()*1000),
        "dm_pending": len(_pending),
        "metrics": METRICS.snapshot(),
    })

@app.post("/forward")
def forward():
    data = request.get_json(force=True, silent=True) or {}
    dest = (data.get("dest") or "").strip()
    locations = data.get("locations")  # string "lat,lng|..." or list of {lat,lng}
    dataset = data.get("dataset") or ELEV_DATASET
    if not dest or not locations:
        return jsonify({"error":"dest and locations required"}), 400
    dm_id = uuid.uuid4().hex
    payload = {"id": dm_id, "type":"elev.query", "dataset": dataset, "locations": locations}
    wire = base64.b64encode(json.dumps(payload).encode()).decode()

    loop = asyncio.get_event_loop()
    fut: asyncio.Future = loop.create_future()
    _pending[dm_id] = fut

    try:
        sidecar.send(dest, wire, msg_id=dm_id)
    except Exception as e:
        _pending.pop(dm_id, None)
        return jsonify({"error": f"send failed: {e}"}), 502

    try:
        dmresp = loop.run_until_complete(asyncio.wait_for(fut, timeout=ELEV_TIMEOUT_MS/1000.0 + 5))
    except Exception:
        _pending.pop(dm_id, None)
        return jsonify({"error":"dm response timeout"}), 504

    # return body_b64 and utf8 convenience
    body = base64.b64decode(dmresp.get("body_b64") or b"") if dmresp.get("body_b64") else b""
    return jsonify({
        "ok": True, "id": dm_id, "status": dmresp.get("status"), "headers": dmresp.get("headers"),
        "duration_ms": dmresp.get("duration_ms"), "body_b64": dmresp.get("body_b64"),
        "body_utf8": (body.decode("utf-8","ignore") if body else None)
    })

# ─────────────────────────────────────────────────────────────────────────────
# 7) TLS helpers + Serve (Werkzeug/Waitress)
# ─────────────────────────────────────────────────────────────────────────────
def _list_local_ips():
    ips=set()
    try:
        s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(("8.8.8.8",80)); ips.add(s.getsockname()[0]); s.close()
    except Exception: pass
    try:
        host=socket.gethostname()
        for info in socket.getaddrinfo(host, None, socket.AF_INET, socket.SOCK_DGRAM):
            ips.add(info[4][0])
    except Exception: pass
    return sorted(i for i in ips if not i.startswith("127."))

def _get_all_sans():
    dns={"localhost"}; ip={"127.0.0.1"}
    for a in _list_local_ips(): ip.add(a)
    for h in FORWARD_SSL_SANS: dns.add(h)
    return sorted(dns), sorted(ip)

def _generate_self_signed(cert_file: Path, key_file: Path):
    keyobj = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    dns_sans, ip_sans = _get_all_sans()
    san_list = [DNSName(d) for d in dns_sans]
    for i in ip_sans:
        try: san_list.append(IPAddress(ipa.ip_address(i)))
        except ValueError: pass
    san = SubjectAlternativeName(san_list)
    cn = (ip_sans[0] if ip_sans else "localhost")
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])
    not_before = datetime.now(timezone.utc) - timedelta(minutes=5)
    not_after  = not_before + timedelta(days=365)
    cert = (
        x509.CertificateBuilder()
          .subject_name(name).issuer_name(name).public_key(keyobj.public_key())
          .serial_number(x509.random_serial_number())
          .not_valid_before(not_before).not_valid_after(not_after)
          .add_extension(san, critical=False).sign(keyobj, hashes.SHA256())
    )
    TLS_DIR.mkdir(parents=True, exist_ok=True)
    with open(key_file, "wb") as f:
        f.write(keyobj.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption()))
    with open(cert_file, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    log(f"Generated self-signed TLS cert: {cert_file}", "SUCCESS")

def _build_ssl_context():
    mode = FORWARD_SSL_MODE
    if mode in ("0","off","false",""): return None, "http"
    if mode == "adhoc":
        try: return generate_adhoc_ssl_context(), "https"
        except Exception as e: log(f"Adhoc SSL failed: {e}", "ERR"); return None, "http"
    cert_p = Path(FORWARD_SSL_CERT); key_p = Path(FORWARD_SSL_KEY)
    if mode in ("1","true","yes","on","generate"):
        if FORWARD_SSL_REFRESH or (not cert_p.exists() or not key_p.exists()):
            _generate_self_signed(cert_p, key_p)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(str(cert_p), str(key_p))
        return ctx, "https"
    try:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(str(cert_p), str(key_p))
        return ctx, "https"
    except Exception as e:
        log(f"TLS config error ({mode}): {e}. Serving over HTTP.", "WARN"); return None, "http"

def _port_is_free(host: str, port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((host, port)); s.close(); return True
    except OSError:
        try: s.close()
        except: pass
        return False

def _find_free_port(host: str, preferred: int, tries: int=100) -> int:
    for p in range(preferred, preferred+tries+1):
        if _port_is_free(host, p): return p
    raise RuntimeError(f"No free port in range {preferred}..{preferred+tries}")

_server_thread = None
def _start_server():
    global FORWARD_BIND
    if FORWARD_BIND in ("127.0.0.1","localhost","::1") and not FORWARD_FORCE_LOCAL:
        log("FORWARD_BIND was localhost; switching to 0.0.0.0 for LAN access. Set FORWARD_FORCE_LOCAL=1 to keep local-only.", "WARN")
        FORWARD_BIND = "0.0.0.0"
    ssl_ctx, scheme = _build_ssl_context()
    actual_port = _find_free_port(FORWARD_BIND, FORWARD_PORT, tries=100)
    try:
        from waitress import serve as _serve
        threading.Thread(target=lambda: _serve(app, host=FORWARD_BIND, port=actual_port, threads=max(8, FORWARD_CONCURRENCY*2)), daemon=True).start()
        log(f"Forwarder listening on {scheme}://{FORWARD_BIND}:{actual_port}", "SUCCESS")
        try_host = "localhost" if FORWARD_BIND == "0.0.0.0" else FORWARD_BIND
        curl_k = "-k " if scheme == "https" else ""
        log(f"Try: curl {curl_k}-s {scheme}://{try_host}:{actual_port}/healthz | jq", "INFO")
        return actual_port
    except Exception as e:
        log(f"waitress failed ({e}); falling back to Werkzeug.", "WARN")
        class _ServerThread(threading.Thread):
            def __init__(self, app, host, port, ssl_context=None):
                super().__init__(daemon=True)
                self._srv: BaseWSGIServer = make_server(host, port, app, ssl_context=ssl_context)
                self.port=port
            def run(self): self._srv.serve_forever()
            def shutdown(self):
                try: self._srv.shutdown()
                except Exception: pass
        st = _ServerThread(app, FORWARD_BIND, actual_port, ssl_context=ssl_ctx)
        st.start()
        globals()["_server_thread"]=st
        log(f"Forwarder listening on {scheme}://{FORWARD_BIND}:{actual_port}", "SUCCESS")
        return actual_port

def _graceful_exit(signum=None, frame=None):
    log("Shutting down…", "INFO")
    try: sidecar.close()
    except Exception: pass
    os._exit(0)

import atexit
atexit.register(_graceful_exit)
signal = _sig
signal.signal(signal.SIGINT, _graceful_exit)
signal.signal(signal.SIGTERM, _graceful_exit)
if hasattr(signal, "SIGTSTP"):
    signal.signal(signal.SIGTSTP, _graceful_exit)

# ─────────────────────────────────────────────────────────────────────────────
# 8) Main
# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    _start_server()
    try:
        while True:
            try:
                signal.pause()
            except AttributeError:
                time.sleep(3600)
    except KeyboardInterrupt:
        _graceful_exit(signal.SIGINT, None)
