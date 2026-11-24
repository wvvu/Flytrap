# Android Magisk Root SMS Forwarder

## Files
- `99-flytrap-sms.sh`: Magisk `service.d` self-starter (waits for `sys.boot_completed=1` and unlocked CE `mmssms.db`, auto-selects `/system/bin/sqlite3` shell daemon or Termux `python3` daemon).
- `flytrap-sms.sh`: Zero-dependency POSIX shell daemon using `/system/bin/sqlite3` (with `/init.environ.rc` ICU vars), `/system/bin/curl`, and `/data/adb/magisk/busybox inotifyd`.
- `flytrap-sms.py`: Python 3 daemon for devices without `/system/bin/sqlite3` (e.g., OnePlus + Termux).
- `config.env.example`: Device configuration template (no Bark URL hardcoded; Bark target is synced from `/v1/ingest/sms/config` and `POST /v1/ingest/sms` into local cache).

## Deployment Path on Device
- `/data/adb/flytrap-sms/config.env` (`chmod 600`)
- `/data/adb/flytrap-sms/flytrap-sms.sh` (`chmod 700`)
- `/data/adb/flytrap-sms/flytrap-sms.py` (`chmod 700`)
- `/data/adb/service.d/99-flytrap-sms.sh` (`chmod 755`)
