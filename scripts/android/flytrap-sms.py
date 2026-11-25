#!/usr/bin/env python3
"""Root Android SMS daemon (Termux Python 3 runtime + busybox inotifyd)."""

import json
import os
import signal
import sqlite3
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE_DIR = "/data/adb/flytrap-sms"
CONFIG_FILE = os.path.join(BASE_DIR, "config.env")
STATE_FILE = os.path.join(BASE_DIR, "state.json")
BARK_CACHE_FILE = os.path.join(BASE_DIR, "bark_cache.json")
PID_FILE = os.path.join(BASE_DIR, "daemon.pid")
INO_PID_FILE = os.path.join(BASE_DIR, "inotify.pid")
POKE_SCRIPT = os.path.join(BASE_DIR, "poke.sh")
LOG_FILE = os.path.join(BASE_DIR, "daemon.log")

SMS_DB = "/data/data/com.android.providers.telephony/databases/mmssms.db"
SMS_DB_DIR = "/data/data/com.android.providers.telephony/databases"
TEL_DB = "/data/user_de/0/com.android.providers.telephony/databases/telephony.db"
BB = "/data/adb/magisk/busybox"
CA_FILE = "/data/data/com.termux/files/usr/etc/tls/cert.pem"

WAKE_FLAG = False
RUNNING = True


def load_env(path: str) -> dict[str, str]:
    cfg: dict[str, str] = {}
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip().strip('"').strip("'")
    return cfg


def log_msg(msg: str) -> None:
    try:
        if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > 524288:
            os.replace(LOG_FILE, LOG_FILE + ".1")
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
    except OSError:
        pass


def atomic_write_json(path: str, data: object) -> None:
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def read_json(path: str, default: dict) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            val = json.load(f)
            return val if isinstance(val, dict) else default
    except Exception:
        return default


def ssl_context() -> ssl.SSLContext:
    if os.path.exists(CA_FILE):
        return ssl.create_default_context(cafile=CA_FILE)
    return ssl.create_default_context()


def http_json(method: str, url: str, headers: dict[str, str], payload: dict | None = None) -> tuple[int, dict | None]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10, context=ssl_context()) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            try:
                return resp.status, json.loads(raw)
            except Exception:
                return resp.status, None
    except urllib.error.HTTPError as err:
        return err.code, None
    except Exception:
        return 0, None


def resolve_slot(sub_id: int | None, slot_overrides: dict[int, str] | None = None) -> str:
    if sub_id is None or sub_id < 0 or not os.path.exists(TEL_DB):
        return "sim"
    con = None
    try:
        con = sqlite3.connect(f"file:{TEL_DB}?mode=ro", uri=True, timeout=5.0)
        row = con.execute("SELECT sim_id, number FROM siminfo WHERE _id = ? LIMIT 1", (sub_id,)).fetchone()
        if row:
            sim_id = row[0] if isinstance(row[0], int) else -1
            raw_num = str(row[1] or "")
            if slot_overrides and sim_id in slot_overrides and slot_overrides[sim_id]:
                return slot_overrides[sim_id]
            digits = "".join(ch for ch in raw_num if ch.isdigit())
            if len(digits) >= 4:
                return digits[-4:]
            if sim_id >= 0:
                return f"sim{sim_id + 1}"
        if sub_id > 0:
            return f"sub{sub_id}"
    except Exception:
        pass
    finally:
        if con is not None:
            con.close()
    return "sim"


def query_max_id() -> int:
    con = sqlite3.connect(f"file:{SMS_DB}?mode=ro", uri=True, timeout=5.0)
    try:
        row = con.execute("SELECT COALESCE(MAX(_id), 0) FROM sms WHERE type = 1").fetchone()
        return int(row[0]) if row and row[0] is not None else 0
    finally:
        con.close()


def query_pending(last_acked_id: int) -> list[tuple]:
    con = sqlite3.connect(f"file:{SMS_DB}?mode=ro", uri=True, timeout=5.0)
    try:
        return con.execute(
            "SELECT _id, address, date, date_sent, body, sub_id FROM sms WHERE type = 1 AND _id > ? ORDER BY _id ASC LIMIT 50",
            (last_acked_id,),
        ).fetchall()
    finally:
        con.close()


def start_inotify() -> subprocess.Popen | None:
    if not os.path.exists(BB):
        return None
    with open(POKE_SCRIPT, "w", encoding="utf-8") as f:
        f.write(f"#!/system/bin/sh\nkill -USR1 {os.getpid()} 2>/dev/null\n")
    os.chmod(POKE_SCRIPT, 0o700)
    proc = subprocess.Popen(
        [BB, "inotifyd", POKE_SCRIPT, f"{SMS_DB_DIR}:cwynd"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    with open(INO_PID_FILE, "w", encoding="utf-8") as f:
        f.write(str(proc.pid))
    return proc


def main() -> int:
    global WAKE_FLAG, RUNNING
    os.makedirs(BASE_DIR, exist_ok=True)
    cfg = load_env(CONFIG_FILE)
    base_url = cfg.get("FLYTRAP_URL", "").rstrip("/")
    token = cfg.get("SMS_INGEST_TOKEN", "")
    device = cfg.get("DEVICE_ID", "android")
    threshold = int(cfg.get("BARK_FAIL_THRESHOLD", "3"))
    retry_base = int(cfg.get("RETRY_BASE_SEC", "5"))
    retry_max = int(cfg.get("RETRY_MAX_SEC", "60"))
    poll_sec = int(cfg.get("POLL_FALLBACK_SEC", "30"))
    cfg_refresh = int(cfg.get("CONFIG_REFRESH_SEC", "21600"))
    slot_overrides = {
        0: cfg.get("SLOT_1_LABEL", "").strip(),
        1: cfg.get("SLOT_2_LABEL", "").strip(),
    }

    if not base_url or not token:
        sys.stderr.write("FLYTRAP_URL or SMS_INGEST_TOKEN missing\n")
        return 1

    with open(PID_FILE, "w", encoding="utf-8") as f:
        f.write(str(os.getpid()))

    def on_usr1(_sig, _frame):
        global WAKE_FLAG
        WAKE_FLAG = True

    def on_stop(_sig, _frame):
        global RUNNING
        RUNNING = False

    signal.signal(signal.SIGUSR1, on_usr1)
    signal.signal(signal.SIGTERM, on_stop)
    signal.signal(signal.SIGINT, on_stop)

    state = read_json(STATE_FILE, {})
    bark_cache = read_json(BARK_CACHE_FILE, {"url": "", "bearer": "", "updated_at": 0})

    def update_bark_cache(resp: dict | None) -> None:
        if not resp or not isinstance(resp.get("bark"), dict):
            return
        b = resp["bark"]
        url = str(b.get("url") or "").strip()
        bearer = str(b.get("bearer") or "").strip()
        if not url:
            return
        now = int(time.time())
        if url != bark_cache.get("url") or bearer != bark_cache.get("bearer"):
            bark_cache.update({"url": url, "bearer": bearer, "updated_at": now})
            atomic_write_json(BARK_CACHE_FILE, bark_cache)
            log_msg("[INFO] synced bark cache from server")
        else:
            bark_cache["updated_at"] = now

    def sync_config() -> None:
        qs = urllib.parse.urlencode({"device": device})
        code, resp = http_json(
            "GET",
            f"{base_url}/v1/ingest/sms/config?{qs}",
            {"Authorization": f"Bearer {token}"},
        )
        if code == 200 and resp and resp.get("ok") is True:
            update_bark_cache(resp)

    def send_bark_fallback(sms_id: int, slot: str, sender: str, text: str) -> None:
        alerted: list[int] = state.setdefault("bark_alerted_ids", [])
        if sms_id in alerted:
            return
        bark_url = str(bark_cache.get("url") or "").strip()
        if not bark_url:
            log_msg(f"[WARN] bark cache empty, skipped fallback for sms_id={sms_id}")
            return
        headers = {"Content-Type": "application/json; charset=utf-8"}
        if bark_cache.get("bearer"):
            headers["Authorization"] = f"Bearer {bark_cache['bearer']}"
        body_text = text.strip() or "(空短信)"
        payload = {
            "title": f"[短信急救][{device}·{slot}] {sender or '未知号码'}",
            "body": f"{body_text}\n\n(主端 Flytrap 暂未确认，恢复后自动补录)",
            "group": "SMS-Fallback",
            "level": "timeSensitive",
        }
        code, _ = http_json("POST", bark_url, headers, payload)
        if code == 200:
            alerted.append(sms_id)
            if len(alerted) > 200:
                state["bark_alerted_ids"] = alerted[-200:]
            atomic_write_json(STATE_FILE, state)
            log_msg(f"[WARN] sent one-shot emergency Bark push for sms_id={sms_id}")
        else:
            log_msg(f"[ERROR] emergency Bark push failed http={code} sms_id={sms_id}")

    def sleep_interruptible(wait_sec: float) -> None:
        deadline = time.monotonic() + wait_sec
        while RUNNING and not WAKE_FLAG and time.monotonic() < deadline:
            time.sleep(min(0.5, max(0.05, deadline - time.monotonic())))
        if WAKE_FLAG:
            time.sleep(0.3)

    log_msg(f"[INFO] flytrap-sms python daemon starting device={device} url={base_url}")
    sync_config()
    ino = start_inotify()
    init_fails = 0

    try:
        while RUNNING:
            WAKE_FLAG = False
            if ino is None:
                ino = start_inotify()
            elif ino.poll() is not None:
                log_msg(f"[WARN] inotifyd exited rc={ino.returncode}, respawning")
                ino = start_inotify()

            if int(time.time()) - int(bark_cache.get("updated_at") or 0) >= cfg_refresh:
                sync_config()

            if "last_acked_id" not in state:
                try:
                    state = {
                        "last_acked_id": query_max_id(),
                        "fail_count": 0,
                        "bark_alerted_ids": state.get("bark_alerted_ids", []),
                    }
                    atomic_write_json(STATE_FILE, state)
                    init_fails = 0
                    log_msg(f"[INFO] initialized cursor last_acked_id={state['last_acked_id']}")
                except sqlite3.Error as err:
                    init_fails += 1
                    log_msg(f"[WARN] sqlite cursor init failed ({err}) fails={init_fails}")
                    wait_sec = min(retry_max, retry_base * (2 ** (init_fails - 1)))
                    sleep_interruptible(wait_sec)
                    continue

            failed = False
            try:
                pending = query_pending(int(state["last_acked_id"]))
            except sqlite3.Error as err:
                state["fail_count"] = int(state.get("fail_count", 0)) + 1
                atomic_write_json(STATE_FILE, state)
                log_msg(f"[WARN] sqlite query failed ({err}) fails={state['fail_count']}")
                failed = True
                pending = []

            for idx, row in enumerate(pending):
                sms_id, address, date_ms, date_sent_ms, body, sub_id = row
                slot = resolve_slot(sub_id, slot_overrides)
                sender = (address or "").strip() or "unknown-sender"
                ts = date_ms if (date_ms and date_ms > 0) else (date_sent_ms if (date_sent_ms and date_sent_ms > 0) else int(time.time() * 1000))
                code, resp = http_json(
                    "POST",
                    f"{base_url}/v1/ingest/sms",
                    {
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json; charset=utf-8",
                    },
                    {
                        "device": device,
                        "smsId": int(sms_id),
                        "from": sender,
                        "slot": slot,
                        "text": body or "",
                        "receivedAt": int(ts),
                    },
                )
                if code == 200 and resp and resp.get("ok") is True:
                    update_bark_cache(resp)
                    state["last_acked_id"] = int(sms_id)
                    state["fail_count"] = 0
                    atomic_write_json(STATE_FILE, state)
                    log_msg(f"[INFO] acked sms_id={sms_id} slot={slot}")
                elif code in (400, 413, 422):
                    log_msg(f"[ERROR] permanent ingest error sms_id={sms_id} http={code}; skipping")
                    state["last_acked_id"] = int(sms_id)
                    state["fail_count"] = 0
                    atomic_write_json(STATE_FILE, state)
                    continue
                else:
                    state["fail_count"] = int(state.get("fail_count", 0)) + 1
                    atomic_write_json(STATE_FILE, state)
                    log_msg(f"[WARN] ingest failed sms_id={sms_id} http={code} fails={state['fail_count']}")
                    if state["fail_count"] >= threshold:
                        for p_row in pending[idx:]:
                            p_id, p_addr, _d1, _d2, p_body, p_sub = p_row
                            send_bark_fallback(int(p_id), resolve_slot(p_sub, slot_overrides), (p_addr or "").strip(), p_body or "")
                    failed = True
                    break

            if failed:
                fails = max(1, int(state.get("fail_count", 1)))
                wait_sec = min(retry_max, retry_base * (2 ** (fails - 1)))
            else:
                wait_sec = poll_sec

            sleep_interruptible(wait_sec)
    finally:
        if ino and ino.poll() is None:
            ino.terminate()
        for f in (PID_FILE, INO_PID_FILE):
            if os.path.exists(f):
                os.remove(f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
