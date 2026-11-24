#!/system/bin/sh
# Magisk service.d launcher for Flytrap SMS forwarder.
BASE_DIR="/data/adb/flytrap-sms"
LOG_FILE="$BASE_DIR/service.log"
SMS_DB="/data/data/com.android.providers.telephony/databases/mmssms.db"

export ANDROID_ROOT="/system"
export ANDROID_DATA="/data"
export ANDROID_ASSETS="/system/app"
export ANDROID_STORAGE="/storage"
export ANDROID_ART_ROOT="/apex/com.android.art"
export ANDROID_I18N_ROOT="/apex/com.android.i18n"
export ANDROID_TZDATA_ROOT="/apex/com.android.tzdata"

(
  while [ "$(getprop sys.boot_completed)" != "1" ]; do
    sleep 2
  done

  # Wait for credential-encrypted telephony storage to unlock and mount.
  while [ ! -r "$SMS_DB" ]; do
    sleep 3
  done

  [ -f "$BASE_DIR/config.env" ] || exit 0
  mkdir -p "$BASE_DIR/tmp"
  chmod 700 "$BASE_DIR" "$BASE_DIR/tmp"

  # Stop previous instance if any.
  if [ -f "$BASE_DIR/daemon.pid" ]; then
    old_pid="$(cat "$BASE_DIR/daemon.pid" 2>/dev/null)"
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
      kill "$old_pid" 2>/dev/null
      sleep 1
    fi
  fi
  if [ -f "$BASE_DIR/inotify.pid" ]; then
    old_ino="$(cat "$BASE_DIR/inotify.pid" 2>/dev/null)"
    [ -n "$old_ino" ] && kill "$old_ino" 2>/dev/null
  fi

  if [ -x /system/bin/sqlite3 ] && /system/bin/sqlite3 :memory: "SELECT 1;" >/dev/null 2>&1; then
    exec sh "$BASE_DIR/flytrap-sms.sh" >>"$LOG_FILE" 2>&1
  elif [ -x /data/data/com.termux/files/usr/bin/python3 ]; then
    export LD_LIBRARY_PATH="/data/data/com.termux/files/usr/lib"
    export SSL_CERT_FILE="/data/data/com.termux/files/usr/etc/tls/cert.pem"
    exec /data/data/com.termux/files/usr/bin/python3 "$BASE_DIR/flytrap-sms.py" >>"$LOG_FILE" 2>&1
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') [ERROR] no sqlite3 or python3 runtime found" >>"$LOG_FILE"
  fi
) &
