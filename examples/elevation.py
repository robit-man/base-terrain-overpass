#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NKN Elevation Forwarder — geohash-aware (drop-in), venv-bootstrapped.

New in this version:
- 🔐 Persistent NKN identity: generates a seed once and saves it to NKN_SEED_FILE
  (default sidecar/nkn.seed), then reuses it across restarts. You can still force
  a specific key by setting NKN_SEED in .env.

Other notes:
- Accepts geohashes or lat/lng over DM and HTTP (OpenTopoData-compatible).
"""

from __future__ import annotations
import os, sys, subprocess, json, time, uuid, threading, base64, shutil, socket, ssl, re, math, hashlib
from pathlib import Path
from typing import Any, Dict, Optional, List, Tuple
from datetime import datetime, timezone, timedelta

# ─────────────────────────────────────────────────────────────────────────────
# 0) Minimal re-exec into a local venv
# ─────────────────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
VENV_DIR   = SCRIPT_DIR / ".venv"
SETUP_MKR  = SCRIPT_DIR / ".forwarder_setup_complete"
SIDE_DIR   = SCRIPT_DIR / "sidecar"
SIDECAR_JS = SIDE_DIR / "sidecar.js"
SIDECAR_PKG = SIDE_DIR / "package.json"
SIDECAR_NKN = SIDE_DIR / "node_modules" / "nkn-sdk"
DEFAULT_SEED_RPC = [
    "https://mainnet-seed-0001.nkn.org/mainnet/api/wallet",
    "https://mainnet-seed-0002.nkn.org/mainnet/api/wallet",
    "https://mainnet-seed-0003.nkn.org/mainnet/api/wallet"
]
DEFAULT_SEED_WS = [
    "wss://mainnet-seed-0001.nkn.org/mainnet/ws",
    "wss://mainnet-seed-0002.nkn.org/mainnet/ws",
    "wss://mainnet-seed-0003.nkn.org/mainnet/ws"
]

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
# 1) First-run deps and sidecar
# ─────────────────────────────────────────────────────────────────────────────
if SETUP_MKR.exists():
    missing = []
    if not SIDE_DIR.is_dir(): missing.append("sidecar/")
    if not SIDECAR_JS.exists(): missing.append("sidecar.js")
    if not SIDECAR_PKG.exists(): missing.append("package.json")
    if not SIDECAR_NKN.exists(): missing.append("nkn-sdk")
    if missing:
        print(f"[WARN] Missing sidecar assets ({', '.join(missing)}); re-running setup.", flush=True)
        try: SETUP_MKR.unlink()
        except FileNotFoundError: pass

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
            "FORWARD_CONCURRENCY=4\n"
            "FORWARD_RATE_RPS=6\n"
            "FORWARD_RATE_BURST=12\n"
            "\n"
            "FORWARD_SSL=0\n"
            "FORWARD_SSL_CERT=tls/cert.pem\n"
            "FORWARD_SSL_KEY=tls/key.pem\n"
            "FORWARD_SSL_REFRESH=0\n"
            "FORWARD_SSL_EXTRA_DNS_SANS=\n"
            "\n"
            "ELEV_BASE=http://localhost:5000\n"
            "ELEV_DATASET=mapzen\n"
            "ELEV_TIMEOUT_MS=10000\n"
            "\n"
            "NKN_IDENTIFIER=forwarder\n"
            "NKN_SEED=\n"                      # you can still hard-pin a seed here
            "NKN_SEED_FILE=sidecar/nkn.seed\n" # ⬅ seed will be persisted here
            "NKN_SUBCLIENTS=8\n"
            "NKN_RESPONSE_TIMEOUT_MS=20000\n"
            "NKN_MSG_HOLDING_S=90\n"
            "NKN_WS_HEARTBEAT_MS=120000\n"
            "NKN_SEND_DELAY_MS=250\n"
            "NKN_SEND_QUEUE_MAX=256\n"
            "NKN_RPC_ADDRS=\n"
            "DM_CHUNK_LIMIT_BYTES=1024\n"
        )
        print("[SUCCESS] Wrote .env with defaults.", flush=True)

    # Sidecar files
    SIDE_DIR.mkdir(parents=True, exist_ok=True)
    (SIDE_DIR / ".gitignore").write_text("node_modules/\npackage-lock.json\n")

    if not SIDECAR_PKG.exists():
        subprocess.check_call(["npm", "init", "-y"], cwd=str(SIDE_DIR))

    # keep sidecar minimal; seed persistence is handled in Python before launch
    SIDECAR_JS.write_text(r"""
const readline = require('readline');
const { MultiClient } = require('nkn-sdk');
function ndj(obj){ try{ process.stdout.write(JSON.stringify(obj)+"\n"); }catch{} }
(async () => {
  const identifier = (process.env.NKN_IDENTIFIER || 'forwarder').trim();
  const seed = (process.env.NKN_SEED || '').trim() || undefined;
  const numSubClients = Math.max(1, parseInt(process.env.NKN_SUBCLIENTS || '4', 10));
  const rpcStr = (process.env.NKN_RPC_ADDRS || '').trim();
  const rpcServerAddr = rpcStr ? rpcStr.split(',').map(s=>s.trim()).filter(Boolean) : undefined;
  const seedRpcServerAddr = (process.env.NKN_SEED_RPC_ADDRS || '').split(',').map(s=>s.trim()).filter(Boolean);
  const seedWsAddr = (process.env.NKN_SEED_WS_ADDRS || '').split(',').map(s=>s.trim()).filter(Boolean);
  const responseTimeout = Math.max(5000, parseInt(process.env.NKN_RESPONSE_TIMEOUT_MS || '20000', 10) || 20000);
  const msgHoldingSeconds = Math.max(30, parseInt(process.env.NKN_MSG_HOLDING_S || '90', 10) || 90);
  const wsConnHeartbeatTimeout = Math.max(30000, parseInt(process.env.NKN_WS_HEARTBEAT_MS || '120000', 10) || 120000);
  let mc;
  try { mc = new MultiClient({
      identifier,
      seed,
      numSubClients,
      originalClient: false,
      rpcServerAddr,
      seedRpcServerAddr: seedRpcServerAddr.length ? seedRpcServerAddr : undefined,
      seedWsAddr: seedWsAddr.length ? seedWsAddr : undefined,
      tls: true,
      responseTimeout,
      msgHoldingSeconds,
      msgCacheExpiration: 300000,
      reconnectIntervalMin: 1000,
      reconnectIntervalMax: 8000,
      wsConnHeartbeatTimeout
    }); }
  catch (e) { ndj({ ev:"error", message: String(e && e.message || e) }); process.exit(1); }
  mc.onConnect(() => ndj({ ev:"ready", addr: mc.addr }));
  mc.onMessage(({ src, payload }) => {
    try { const buf = (typeof payload === 'string') ? Buffer.from(payload) : Buffer.from(payload);
      ndj({ ev:"message", src, payload_b64: buf.toString('base64') }); }
    catch (e) { ndj({ ev:"error", message: "onMessage decode: "+(e && e.message || e) }); }
  });
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.op === 'send') {
      try { const dest = String(msg.dest || '').trim(); if (!dest) return ndj({ ev:"error", message:"missing dest", id: msg.id });
        const data = msg.payload_b64 ? Buffer.from(msg.payload_b64, 'base64') : Buffer.alloc(0);
        await mc.send(dest, data); ndj({ ev:"sent", id: msg.id, dest }); }
      catch (e) { ndj({ ev:"error", id: msg.id, message: String(e && e.message || e) }); }
    } else if (msg.op === 'close') { try { await mc.close(); } catch {} process.exit(0); }
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
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv
import requests

load_dotenv(SCRIPT_DIR / ".env")

FORWARD_BIND        = os.getenv("FORWARD_BIND", "0.0.0.0")
FORWARD_PORT        = int(os.getenv("FORWARD_PORT", "9011"))
FORWARD_FORCE_LOCAL = os.getenv("FORWARD_FORCE_LOCAL", "0") == "1"
FORWARD_CONCURRENCY = max(1, min(4, int(os.getenv("FORWARD_CONCURRENCY", "4"))))
FORWARD_RATE_RPS    = max(1, min(6, int(os.getenv("FORWARD_RATE_RPS", "6"))))
FORWARD_RATE_BURST  = max(1, min(12, int(os.getenv("FORWARD_RATE_BURST", "12"))))

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
NKN_SEED_FILE       = os.getenv("NKN_SEED_FILE", "sidecar/nkn.seed").strip()  # ⬅ added
NKN_SUBCLIENTS      = max(1, min(8, int(os.getenv("NKN_SUBCLIENTS", "8"))))
NKN_RPC_ADDRS       = [s.strip() for s in os.getenv("NKN_RPC_ADDRS","").split(",") if s.strip()]
DM_CHUNK_LIMIT_BYTES = max(0, int(os.getenv("DM_CHUNK_LIMIT_BYTES", "800000")))  # hard cap ~800 KB per chunk
NKN_RESPONSE_TIMEOUT_MS = max(5000, int(os.getenv("NKN_RESPONSE_TIMEOUT_MS", "20000")))
NKN_MSG_HOLDING_S      = max(30, int(os.getenv("NKN_MSG_HOLDING_S", "90")))
NKN_WS_HEARTBEAT_MS    = max(30000, int(os.getenv("NKN_WS_HEARTBEAT_MS", "120000")))
NKN_SEND_DELAY_MS      = max(0, int(os.getenv("NKN_SEND_DELAY_MS", "250")))
NKN_SEND_QUEUE_MAX     = max(32, int(os.getenv("NKN_SEND_QUEUE_MAX", "256")))
NKN_SEED_RPC_ADDRS     = [s.strip() for s in os.getenv("NKN_SEED_RPC_ADDRS", "").split(",") if s.strip()]
NKN_SEED_WS_ADDRS      = [s.strip() for s in os.getenv("NKN_SEED_WS_ADDRS", "").split(",") if s.strip()]

TLS_DIR             = SCRIPT_DIR / "tls"
TLS_DIR.mkdir(exist_ok=True, parents=True)

# ─────────────────────────────────────────────────────────────────────────────
# 2.1) Ensure a persistent NKN seed (so the address is stable across restarts)
# ─────────────────────────────────────────────────────────────────────────────
def _ensure_persisted_seed():
    """
    Ensures env var NKN_SEED is set, loading it from NKN_SEED_FILE or generating
    a new one (via Node 'nkn-sdk' Wallet) and saving it to disk (0600).
    """
    global NKN_SEED
    if NKN_SEED:
        # explicit seed provided; do not overwrite file
        print(f"[PROCESS] Using NKN_SEED from environment (length={len(NKN_SEED)}).", flush=True)
        return

    seed_path = (SCRIPT_DIR / NKN_SEED_FILE).resolve()
    try:
        if seed_path.exists():
            seed = seed_path.read_text(encoding="utf-8").strip()
            if seed:
                os.environ["NKN_SEED"] = seed
                NKN_SEED = seed
                print(f"[PROCESS] Loaded persisted NKN seed from {seed_path}", flush=True)
                return
    except Exception as e:
        print(f"[WARN] Could not read NKN_SEED_FILE: {e}", flush=True)

    # Generate a seed using Node's nkn-sdk (so format is guaranteed)
    try:
        SIDE_DIR.mkdir(parents=True, exist_ok=True)
        cmd = [
            "node", "-e",
            r"""
const { Wallet } = require('nkn-sdk');
const w = new Wallet();
const s = (typeof w.getSeed==='function') ? w.getSeed() : (w.seed || '');
if (!s) { process.stderr.write('no-seed'); process.exit(1); }
process.stdout.write(s);
"""
        ]
        seed = subprocess.check_output(cmd, cwd=str(SIDE_DIR)).decode("utf-8", "ignore").strip()
        if not seed:
            raise RuntimeError("empty seed from wallet")
        seed_path.parent.mkdir(parents=True, exist_ok=True)
        with open(seed_path, "w", encoding="utf-8") as f:
            f.write(seed)
        try:
            os.chmod(seed_path, 0o600)
        except Exception:
            pass
        os.environ["NKN_SEED"] = seed
        NKN_SEED = seed
        print(f"[SUCCESS] Generated and persisted new NKN seed at {seed_path}", flush=True)
    except Exception as e:
        print(f"[ERR] Failed to generate NKN seed using Node sidecar deps: {e}", flush=True)
        # Sidecar will fall back to ephemeral if we proceed without a seed.

# ─────────────────────────────────────────────────────────────────────────────
# 3) Small logging, rate limit, semaphore
# ─────────────────────────────────────────────────────────────────────────────
CLR = {"RESET":"\033[0m","INFO":"\033[94m","SUCCESS":"\033[92m","WARN":"\033[93m","ERR":"\033[91m"}
def log(msg, cat="INFO"):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    c = CLR.get(cat, ""); e = CLR["RESET"] if c else ""
    print(f"{c}[{ts}] {cat}: {msg}{e}", flush=True)

METRICS = {
    "dm_received": 0,
    "dm_errors": 0,
    "dm_forwarded": 0,
    "dm_chunked_out": 0,
    "dm_bytes_in": 0,
    "dm_bytes_out": 0,
    "http_calls": 0,
    "http_fail": 0,
}

def _bump(key: str, delta: int = 1):
    try:
        METRICS[key] = METRICS.get(key, 0) + delta
    except Exception:
        pass

def _fmt_kb(num: int) -> str:
    try:
        return f"{num/1024:.1f} KB"
    except Exception:
        return f"{num} B"

def _metrics_summary() -> str:
    ok = METRICS.get("dm_forwarded", 0)
    err = METRICS.get("dm_errors", 0)
    chunked = METRICS.get("dm_chunked_out", 0)
    return f"ok={ok} err={err} chunked={chunked} in={_fmt_kb(METRICS.get('dm_bytes_in',0))} out={_fmt_kb(METRICS.get('dm_bytes_out',0))}"

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
# 4) NKN sidecar supervisor — NDJSON bridge
# ─────────────────────────────────────────────────────────────────────────────
import threading, queue

class Sidecar:
    def __init__(self):
        self.proc = None
        self.reader = None
        self.addr = None
        self.events = queue.Queue()   # (ev, data_dict)
        self.lock = threading.Lock()
        self.send_q: "queue.Queue[Tuple[str,str,str]]" = queue.Queue(maxsize=NKN_SEND_QUEUE_MAX)
        self.stop_evt = threading.Event()
        self.sender = None
    def start(self):
        if not shutil.which("node"):
            log("Node.js is required (not found on PATH).", "ERR"); sys.exit(1)

        # Ensure we have a persistent seed before launching the sidecar:
        _ensure_persisted_seed()

        env = os.environ.copy()
        env["NKN_IDENTIFIER"] = NKN_IDENTIFIER
        env["NKN_SEED"] = os.getenv("NKN_SEED", "").strip()  # may be set by _ensure_persisted_seed()
        env["NKN_SUBCLIENTS"] = str(NKN_SUBCLIENTS)
        if NKN_RPC_ADDRS:
            env["NKN_RPC_ADDRS"] = ",".join(NKN_RPC_ADDRS)
        env["NKN_RESPONSE_TIMEOUT_MS"] = str(NKN_RESPONSE_TIMEOUT_MS)
        env["NKN_MSG_HOLDING_S"] = str(NKN_MSG_HOLDING_S)
        env["NKN_WS_HEARTBEAT_MS"] = str(NKN_WS_HEARTBEAT_MS)
        if NKN_SEED_RPC_ADDRS:
            env["NKN_SEED_RPC_ADDRS"] = ",".join(NKN_SEED_RPC_ADDRS)
        else:
            env["NKN_SEED_RPC_ADDRS"] = ",".join(DEFAULT_SEED_RPC)
        if NKN_SEED_WS_ADDRS:
            env["NKN_SEED_WS_ADDRS"] = ",".join(NKN_SEED_WS_ADDRS)
        else:
            env["NKN_SEED_WS_ADDRS"] = ",".join(DEFAULT_SEED_WS)

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
        self.sender = threading.Thread(target=self._drain_send_queue, daemon=True, name="nkn-send"); self.sender.start()

    def _drain_send_queue(self):
        delay = NKN_SEND_DELAY_MS / 1000.0
        while not self.stop_evt.is_set():
            try:
                dest, payload_b64, msg_id = self.send_q.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                self._send_now(dest, payload_b64, msg_id)
            except Exception as e:
                log(f"send queue error ({msg_id}): {e}", "WARN")
            if delay > 0:
                time.sleep(delay)

    def _send_now(self, dest: str, payload_b64: str, msg_id: str):
        if not self.proc or not self.proc.stdin:
            raise RuntimeError("sidecar not running")
        cmd = {"op":"send", "id": msg_id, "dest": dest, "payload_b64": payload_b64}
        self.proc.stdin.write(json.dumps(cmd)+"\n"); self.proc.stdin.flush()

    def send(self, dest: str, payload_b64: str, msg_id: str):
        try:
            self.send_q.put((dest, payload_b64, msg_id), timeout=1.0)
        except queue.Full:
            raise RuntimeError("sidecar send queue is full; backpressure active")

    def close(self):
        self.stop_evt.set()
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
# 5) Geohash utilities (pure Python; no deps)
# ─────────────────────────────────────────────────────────────────────────────
_GH32 = "0123456789bcdefghjkmnpqrstuvwxyz"
_GHMAP = {c:i for i,c in enumerate(_GH32)}

def geohash_decode(gh: str) -> Tuple[float, float]:
    even = True
    lat_min, lat_max = -90.0, 90.0
    lon_min, lon_max = -180.0, 180.0
    for c in gh.strip():
        val = _GHMAP.get(c)
        if val is None: raise ValueError(f"invalid geohash char: {c}")
        for mask in (16,8,4,2,1):
            if even:
                mid = (lon_min + lon_max) / 2
                if val & mask: lon_min = mid
                else:          lon_max = mid
            else:
                mid = (lat_min + lat_max) / 2
                if val & mask: lat_min = mid
                else:          lat_max = mid
            even = not even
    return ( (lat_min + lat_max) / 2, (lon_min + lon_max) / 2 )

def _looks_like_geohash_token(tok: str) -> bool:
    tok = tok.strip().lower()
    if not tok or ("," in tok) or (" " in tok): return False
    return all(ch in _GHMAP for ch in tok)

def _parse_locations_or_geohashes(payload: Dict[str, Any]) -> Tuple[str, List[Tuple[float,float]], Optional[List[str]]]:
    """
    Returns (mode, latlng_list, geohashes_or_None)
      mode: "geohash" or "latlng"
    Accepts:
      - payload["geohashes"]: list[str] or "gh|gh|gh"
      - payload["locations"]: list[{lat,lng}] or list["gh","gh"] or "lat,lng|..." or "gh|gh|..."
    """
    # 1) explicit geohashes
    if "geohashes" in payload and payload["geohashes"]:
        if isinstance(payload["geohashes"], str):
            ghs = [t for t in payload["geohashes"].split("|") if t.strip()]
        else:
            ghs = [str(t).strip() for t in payload["geohashes"] if str(t).strip()]
        latlng = [geohash_decode(g) for g in ghs]
        return "geohash", latlng, ghs

    # 2) locations as list/str — could be lat/lng or geohash strings
    locs = payload.get("locations")
    if isinstance(locs, list) and locs:
        if isinstance(locs[0], dict) and ("lat" in locs[0]) and ("lng" in locs[0]):
            return "latlng", [(float(p["lat"]), float(p["lng"])) for p in locs], None
        if isinstance(locs[0], str):
            toks = [t.strip() for t in locs if t.strip()]
            if toks and all(_looks_like_geohash_token(t) for t in toks):
                latlng = [geohash_decode(g) for g in toks]
                return "geohash", latlng, toks
            pairs: List[Tuple[float,float]] = []
            for t in toks:
                if "," not in t: raise ValueError("locations[] token missing comma")
                a,b = t.split(",",1)
                pairs.append((float(a),float(b)))
            return "latlng", pairs, None

    if isinstance(locs, str) and locs.strip():
        toks = [t for t in locs.split("|") if t.strip()]
        if toks and all(_looks_like_geohash_token(t) for t in toks):
            latlng = [geohash_decode(g) for g in toks]
            return "geohash", latlng, toks
        pairs: List[Tuple[float,float]] = []
        for t in toks:
            a,b = t.split(",",1)
            pairs.append((float(a),float(b)))
        return "latlng", pairs, None

    raise ValueError("No locations/geohashes provided")

# ─────────────────────────────────────────────────────────────────────────────
# 6) Upstream call helper
# ─────────────────────────────────────────────────────────────────────────────
def _now_ms() -> int: return int(time.time()*1000)

def _http_elev_query_from_latlng(latlng: List[Tuple[float,float]], dataset: Optional[str]) -> Dict[str, Any]:
    pairs = [f"{lat:.6f},{lng:.6f}" for (lat,lng) in latlng]
    loc_q = "|".join(pairs)
    ds = (dataset or ELEV_DATASET).strip() or ELEV_DATASET
    url = f"{ELEV_BASE}/v1/{ds}?locations={requests.utils.quote(loc_q, safe='|,')}"
    t0 = _now_ms()
    try:
        resp = requests.get(url, timeout=ELEV_TIMEOUT_MS/1000.0)
        dur = _now_ms() - t0
        body = resp.content or b""
        headers = {str(k): str(v) for k, v in resp.headers.items()}
        return {"status": resp.status_code, "headers": headers, "body_b64": base64.b64encode(body).decode(), "duration_ms": dur}
    except Exception as e:
        return {"status": 502, "headers": {"content-type":"application/json"},
                "body_b64": base64.b64encode(json.dumps({"error": f"upstream failure: {e}"}).encode()).decode(),
                "duration_ms": 0}

def _compute_chunk_limit(msg: Dict[str, Any]) -> int:
    """Determine chunk size for DM responses (raw bytes per chunk)."""
    base = DM_CHUNK_LIMIT_BYTES
    raw = msg.get("max_chunk_bytes") or msg.get("chunk_bytes")
    limit = base
    if raw is not None:
        try:
            limit = int(raw)
        except (TypeError, ValueError):
            limit = base
    if limit is None:
        limit = base
    if limit <= 0:
        return 0
    if base > 0:
        return min(limit, base)
    return limit

def _decode_body(resp: Dict[str, Any]) -> bytes:
    b64 = resp.get("body_b64")
    if not b64:
        return b""
    try:
        data = b64 if isinstance(b64, (bytes, bytearray)) else str(b64).encode()
        return base64.b64decode(data)
    except Exception:
        return b""

def _emit_chunked_response(src: str, resp: Dict[str, Any], rid: str, body: bytes, chunk_limit: int):
    if not body:
        wire = base64.b64encode(json.dumps(resp, separators=(",",":")).encode()).decode()
        sidecar.send(src, wire, msg_id=rid)
        return
    chunk_size = max(1, chunk_limit)
    total = len(body)
    chunk_count = max(1, math.ceil(total / chunk_size))
    digest = hashlib.sha256(body).hexdigest()
    for idx in range(chunk_count):
        start = idx * chunk_size
        chunk = body[start:start+chunk_size]
        chunk_msg = {
            "type": "http.chunk",
            "id": rid,
            "chunk_index": idx,
            "chunk_count": chunk_count,
            "bytes_total": total,
            "body_b64": base64.b64encode(chunk).decode()
        }
        wire = base64.b64encode(json.dumps(chunk_msg, separators=(",",":")).encode()).decode()
        sidecar.send(src, wire, msg_id=f"{rid}-chunk-{idx}")
    resp = dict(resp)
    resp["chunked"] = True
    resp["chunk_count"] = chunk_count
    resp["bytes_total"] = total
    resp["body_digest"] = digest
    resp["body_b64"] = ""
    wire_resp = base64.b64encode(json.dumps(resp, separators=(",",":")).encode()).decode()
    sidecar.send(src, wire_resp, msg_id=rid)

def _send_http_response(src: str, mid: str, resp: Dict[str, Any], chunk_limit: int):
    rid = mid or resp.get("id") or uuid.uuid4().hex
    meta = {"bytes_total": 0, "chunk_count": 0, "chunk_limit": chunk_limit or 0}
    payload = dict(resp)
    payload["id"] = rid
    body_len = len(_decode_body(payload))
    meta["bytes_total"] = body_len
    if chunk_limit > 0:
        body = _decode_body(payload)
        if len(body) > chunk_limit:
            chunk_count = math.ceil(len(body) / max(1, chunk_limit))
            meta["chunk_count"] = chunk_count
            _emit_chunked_response(src, payload, rid, body, chunk_limit)
            return meta
    wire = base64.b64encode(json.dumps(payload, separators=(",",":")).encode()).decode()
    sidecar.send(src, wire, msg_id=rid)
    return meta

# ─────────────────────────────────────────────────────────────────────────────
# 7) Dispatcher consuming sidecar events
# ─────────────────────────────────────────────────────────────────────────────
def _handle_incoming_dm(src: str, payload_b64: str):
    _bump("dm_received")
    try:
        raw = base64.b64decode(payload_b64) if payload_b64 else b""
        msg = json.loads(raw.decode("utf-8", "ignore") or "{}")
    except Exception:
        _bump("dm_errors")
        return
    _bump("dm_bytes_in", len(raw))
    t = str(msg.get("type","")).lower()
    mid = str(msg.get("id") or "")
    chunk_limit = _compute_chunk_limit(msg)

    if t == "ping":
        reply = {
            "id": mid or uuid.uuid4().hex,
            "type": "pong",
            "ts": int(time.time()*1000),
            "addr": sidecar.addr
        }
        wire = base64.b64encode(json.dumps(reply, separators=(",",":")).encode()).decode()
        sidecar.send(src, wire, msg_id=mid or uuid.uuid4().hex)
        log(f"[DM] pong → {src} id={mid or 'auto'}", "INFO")
        return

    # Fulfill /forward futures
    if t == "http.response" and mid:
        fut = _pending.pop(mid, None)
        if fut and not fut.done():
            fut.set_result(msg)
        return

    if t in ("elev.query", "http.request"):
        started = time.time()
        if t == "elev.query":
            dataset  = msg.get("dataset") or ELEV_DATASET
            try:
                mode, latlng, gh_list = _parse_locations_or_geohashes(msg)
            except Exception as e:
                reply = {"id": mid or uuid.uuid4().hex, "type":"http.response",
                         "status": 400, "headers": {"content-type":"application/json"},
                         "body_b64": base64.b64encode(json.dumps({"error": f"bad request: {e}"}).encode()).decode(),
                         "duration_ms": 0}
                _bump("dm_errors")
                _send_http_response(src, mid, reply, chunk_limit)
                log(f"[DM] elev.query ❌ bad request from {src} id={mid or 'n/a'} err={e} chunkLimit={_fmt_kb(chunk_limit)}", "WARN")
                return

            with _CONC:
                resp = _http_elev_query_from_latlng(latlng, dataset)
            _bump("http_calls")
            if mode == "geohash" and gh_list is not None:
                try:
                    body_bytes = base64.b64decode(resp.get("body_b64") or b"")
                    upstream = json.loads(body_bytes.decode("utf-8","ignore") or "{}")
                    results = upstream.get("results") or []
                    out = []
                    if len(results) == len(gh_list):
                        for gh, r in zip(gh_list, results):
                            elev = r.get("elevation", None)
                            out.append({"geohash": gh, "elevation": elev})
                    else:
                        m = {}
                        for r in results:
                            loc = r.get("location") or {}
                            k = f'{float(loc.get("lat",0.0)):.6f},{float(loc.get("lng",0.0)):.6f}'
                            m[k] = r.get("elevation", None)
                        for gh, (lat,lng) in zip(gh_list, latlng):
                            k = f"{lat:.6f},{lng:.6f}"
                            out.append({"geohash": gh, "elevation": m.get(k)})
                    body = json.dumps({"results": out}, separators=(",",":")).encode()
                    resp["body_b64"] = base64.b64encode(body).decode()
                    resp["headers"] = dict(resp.get("headers") or {})
                    resp["headers"]["content-type"] = "application/json"
                except Exception as e:
                    log(f"repack failed (geohash mode): {e}", "WARN")

            reply = {"id": mid or uuid.uuid4().hex, "type":"http.response", **resp}
            meta = _send_http_response(src, mid, reply, chunk_limit) or {}
            dur_ms = resp.get("duration_ms", 0)
            status = resp.get("status")
            ok = isinstance(status, int) and status < 500
            _bump("dm_forwarded")
            if not ok:
                _bump("dm_errors"); _bump("http_fail")
            if meta.get("bytes_total"):
                _bump("dm_bytes_out", meta["bytes_total"])
            if meta.get("chunk_count"):
                _bump("dm_chunked_out", meta["chunk_count"])
            log(f"[DM] elev.query → {src} id={mid or reply['id']} mode={mode} geos={len(gh_list or latlng)} chunkLimit={_fmt_kb(meta.get('chunk_limit',0))} "
                f"resp={status} bytes={_fmt_kb(meta.get('bytes_total',0))} chunks={meta.get('chunk_count',0)} upstream={dur_ms}ms in={len(raw)}B stats={_metrics_summary()}",
                "SUCCESS" if ok else "WARN")
            return

        if t == "http.request":
            method = str(msg.get("method","GET")).upper()
            url    = str(msg.get("url","")).strip()
            if method != "GET" or not url.startswith("/v1/"):
                body = base64.b64encode(json.dumps({"error":"only GET /v1/<dataset>?locations=... supported"}).encode()).decode()
                reply = {"id": mid or uuid.uuid4().hex, "type":"http.response", "status":400, "headers":{"content-type":"application/json"}, "body_b64": body, "duration_ms":0}
                _send_http_response(src, mid, reply, chunk_limit)
                _bump("dm_errors")
                log(f"[DM] http.request ❌ invalid method/url from {src} id={mid or reply['id']} url={url}", "WARN")
                return
            m = re.match(r"^/v1/([^?]+)\?locations=(.+)$", url)
            if not m:
                body = base64.b64encode(json.dumps({"error":"missing locations"}).encode()).decode()
                reply = {"id": mid or uuid.uuid4().hex, "type":"http.response", "status":400, "headers":{"content-type":"application/json"}, "body_b64": body, "duration_ms":0}
                _send_http_response(src, mid, reply, chunk_limit)
                _bump("dm_errors")
                log(f"[DM] http.request ❌ missing locations from {src} id={mid or reply['id']}", "WARN")
                return
            dataset = m.group(1)
            locs_q = requests.utils.unquote(m.group(2))
            try:
                if "|" in locs_q and ("," not in locs_q):
                    gh_list = [t for t in locs_q.split("|") if t.strip()]
                    latlng = [geohash_decode(g) for g in gh_list]
                    with _CONC:
                        resp = _http_elev_query_from_latlng(latlng, dataset)
                    _bump("http_calls")
                    try:
                        body_bytes = base64.b64decode(resp.get("body_b64") or b"")
                        upstream = json.loads(body_bytes.decode("utf-8","ignore") or "{}")
                        results = upstream.get("results") or []
                        out = []
                        if len(results) == len(gh_list):
                            for gh, r in zip(gh_list, results):
                                out.append({"geohash": gh, "elevation": r.get("elevation")})
                        else:
                            mlat = {}
                            for r in results:
                                loc = r.get("location") or {}
                                k = f'{float(loc.get("lat",0.0)):.6f},{float(loc.get("lng",0.0)):.6f}'
                                mlat[k] = r.get("elevation", None)
                            for gh, (lat,lng) in zip(gh_list, latlng):
                                out.append({"geohash": gh, "elevation": mlat.get(f"{lat:.6f},{lng:.6f}")})
                        body = json.dumps({"results": out}, separators=(",",":")).encode()
                        resp["body_b64"] = base64.b64encode(body).decode()
                        resp["headers"] = dict(resp.get("headers") or {})
                        resp["headers"]["content-type"] = "application/json"
                    except Exception as e:
                        log(f"repack failed (http.request geohash): {e}", "WARN")
                    reply = {"id": mid or uuid.uuid4().hex, "type":"http.response", **resp}
                    meta = _send_http_response(src, mid, reply, chunk_limit) or {}
                    status = resp.get("status")
                    ok = isinstance(status, int) and status < 500
                    if not ok:
                        _bump("dm_errors"); _bump("http_fail")
                    _bump("dm_forwarded")
                    if meta.get("bytes_total"):
                        _bump("dm_bytes_out", meta["bytes_total"])
                    if meta.get("chunk_count"):
                        _bump("dm_chunked_out", meta["chunk_count"])
                    log(f"[DM] http.request → {src} id={mid or reply['id']} gh={len(gh_list)} chunkLimit={_fmt_kb(meta.get('chunk_limit',0))} "
                        f"resp={status} bytes={_fmt_kb(meta.get('bytes_total',0))} chunks={meta.get('chunk_count',0)} stats={_metrics_summary()}", "SUCCESS" if ok else "WARN")
                    return
                pairs = [t for t in locs_q.split("|") if t.strip()]
                _ = [tuple(map(float, p.split(",",1))) for p in pairs]
                with _CONC:
                    resp = _http_elev_query_from_latlng(_, dataset)
                _bump("http_calls")
                reply = {"id": mid or uuid.uuid4().hex, "type":"http.response", **resp}
                meta = _send_http_response(src, mid, reply, chunk_limit) or {}
                status = resp.get("status")
                ok = isinstance(status, int) and status < 500
                if not ok:
                    _bump("dm_errors"); _bump("http_fail")
                _bump("dm_forwarded")
                if meta.get("bytes_total"):
                    _bump("dm_bytes_out", meta["bytes_total"])
                if meta.get("chunk_count"):
                    _bump("dm_chunked_out", meta.get("chunk_count"))
                log(f"[DM] http.request → {src} id={mid or reply['id']} locs={len(_)} chunkLimit={_fmt_kb(meta.get('chunk_limit',0))} "
                    f"resp={status} bytes={_fmt_kb(meta.get('bytes_total',0))} chunks={meta.get('chunk_count',0)} stats={_metrics_summary()}", "SUCCESS" if ok else "WARN")
                return
            except Exception as e:
                body = base64.b64encode(json.dumps({"error": f"bad locations: {e}"}).encode()).decode()
                reply = {"id": mid or uuid.uuid4().hex, "type":"http.response", "status":400, "headers":{"content-type":"application/json"}, "body_b64": body, "duration_ms":0}
                _send_http_response(src, mid, reply, chunk_limit)
                _bump("dm_errors")
                log(f"[DM] http.request ❌ bad locations from {src} id={mid or reply['id']} err={e}", "WARN")
                return

def _event_loop():
    while True:
        ev, obj = sidecar.events.get()
        if ev == "message":
            _handle_incoming_dm(obj.get("src"), obj.get("payload_b64") or "")
        elif ev == "error":
            log(f"Sidecar error: {obj.get('message')}", "ERR")
        elif ev == "ready":
            log(f"My NKN address: {obj.get('addr')}", "INFO")

threading.Thread(target=_event_loop, daemon=True, name="nkn-dispatch").start()

# ─────────────────────────────────────────────────────────────────────────────
# 8) Flask HTTP API
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
        "ts": int(time.time()*1000)
    })

@app.post("/forward")
def forward():
    data = request.get_json(force=True, silent=True) or {}
    dest = (data.get("dest") or "").strip()
    dataset = data.get("dataset") or ELEV_DATASET
    if not dest:
        return jsonify({"error":"dest required"}), 400

    try:
        mode, latlng, gh_list = _parse_locations_or_geohashes(data)
    except Exception as e:
        return jsonify({"error": f"bad payload: {e}"}), 400

    dm_id = uuid.uuid4().hex
    payload = {"id": dm_id, "type":"elev.query", "dataset": dataset}
    if mode == "geohash":
        payload["geohashes"] = gh_list
    else:
        payload["locations"] = [{"lat":lat,"lng":lng} for (lat,lng) in latlng]

    wire = base64.b64encode(json.dumps(payload, separators=(",",":")).encode()).decode()

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

    body = base64.b64decode(dmresp.get("body_b64") or b"") if dmresp.get("body_b64") else b""
    return jsonify({
        "ok": True, "id": dm_id, "status": dmresp.get("status"), "headers": dmresp.get("headers"),
        "duration_ms": dmresp.get("duration_ms"), "body_b64": dmresp.get("body_b64"),
        "body_utf8": (body.decode("utf-8","ignore") if body else None)
    })

# ─────────────────────────────────────────────────────────────────────────────
# 9 TLS helpers + Serve
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
    from cryptography.hazmat.primitives.asymmetric import rsa
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
# 10) Main
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
