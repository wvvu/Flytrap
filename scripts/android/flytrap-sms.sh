#!/system/bin/sh
# Root Android SMS daemon (POSIX sh + /system/bin/sqlite3 + /system/bin/curl + busybox inotifyd).
# Guarantees: zero historical backfill on first start, strict HTTP 200 ok:true ack,
# exponential backoff on network/5xx errors, and one-shot emergency Bark push using
# server-synced cached Bark config.

BASE_DIR="/data/adb/flytrap-sms"
CONFIG_FILE="$BASE_DIR/config.env"
STATE_FILE="$BASE_DIR/state.env"
BARK_CACHE_FILE="$BASE_DIR/bark_cache.env"
TMP_DIR="$BASE_DIR/tmp"
PID_FILE="$BASE_DIR/daemon.pid"
INO_PID_FILE="$BASE_DIR/inotify.pid"
POKE_SCRIPT="$BASE_DIR/poke.sh"
LOG_FILE="$BASE_DIR/daemon.log"

BB="/data/adb/magisk/busybox"
SQLITE="/system/bin/sqlite3"
CURL="/system/bin/curl"

export ANDROID_ROOT="/system"
export ANDROID_DATA="/data"
export ANDROID_ASSETS="/system/app"
export ANDROID_STORAGE="/storage"
export ANDROID_ART_ROOT="/apex/com.android.art"
export ANDROID_I18N_ROOT="/apex/com.android.i18n"
export ANDROID_TZDATA_ROOT="/apex/com.android.tzdata"

SMS_DB="/data/data/com.android.providers.telephony/databases/mmssms.db"
SMS_DB_DIR="/data/data/com.android.providers.telephony/databases"
TEL_DB="/data/user_de/0/com.android.providers.telephony/databases/telephony.db"

[ -x "$BB" ] || BB="busybox"
[ -x "$CURL" ] || CURL="/data/data/com.termux/files/usr/bin/curl"

mkdir -p "$TMP_DIR"
chmod 700 "$BASE_DIR" "$TMP_DIR"

# Defaults (overridden by config.env)
FLYTRAP_URL=""
SMS_INGEST_TOKEN=""
DEVICE_ID="android"
BARK_FAIL_THRESHOLD=3
RETRY_BASE_SEC=5
RETRY_MAX_SEC=60
POLL_FALLBACK_SEC=30
CONFIG_REFRESH_SEC=21600
MAX_LOG_BYTES=524288
SLOT_1_LABEL=""
SLOT_2_LABEL=""

# shellcheck disable=SC1090
. "$CONFIG_FILE"

if [ -z "$FLYTRAP_URL" ] || [ -z "$SMS_INGEST_TOKEN" ]; then
  echo "FLYTRAP_URL or SMS_INGEST_TOKEN missing in $CONFIG_FILE" >&2
  exit 1
fi
FLYTRAP_URL="${FLYTRAP_URL%/}"

LAST_ACKED_ID=0
FAIL_COUNT=0
BARK_ALERTED_IDS=""
BARK_URL=""
BARK_BEARER=""
BARK_UPDATED_AT=0

[ -f "$STATE_FILE" ] && . "$STATE_FILE"
[ -f "$BARK_CACHE_FILE" ] && . "$BARK_CACHE_FILE"

log_msg() {
  if [ -f "$LOG_FILE" ]; then
    sz="$($BB stat -c %s "$LOG_FILE" 2>/dev/null || echo 0)"
    if [ "$sz" -gt "$MAX_LOG_BYTES" ] 2>/dev/null; then
      $BB mv -f "$LOG_FILE" "$LOG_FILE.1" 2>/dev/null
    fi
  fi
  echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >>"$LOG_FILE"
}

sql_ro() {
  $SQLITE -batch -cmd ".timeout 5000" "file:$1?mode=ro" "$2" 2>/dev/null
}

sql_mem() {
  $SQLITE -batch ":memory:" "$1" 2>/dev/null
}

escape_sql_str() {
  printf '%s' "$1" | $BB sed "s/'/''/g"
}

json_get() {
  # $1=json string, $2=json path (e.g. $.ok)
  esc="$(escape_sql_str "$1")"
  sql_mem "SELECT CASE WHEN json_valid('$esc') THEN COALESCE(json_extract('$esc', '$2'), '') ELSE '' END;"
}

save_state() {
  # Keep at most last 200 alerted IDs.
  trimmed_ids="$BARK_ALERTED_IDS"
  count="$(printf '%s' "$trimmed_ids" | $BB tr ',' '\n' | $BB grep -c '^[0-9][0-9]*$' 2>/dev/null || echo 0)"
  if [ "$count" -gt 200 ] 2>/dev/null; then
    trimmed_ids="$(printf '%s' "$trimmed_ids" | $BB tr ',' '\n' | $BB grep '^[0-9][0-9]*$' | $BB tail -n 200 | $BB tr '\n' ',' | $BB sed 's/,$//')"
    BARK_ALERTED_IDS="$trimmed_ids"
  fi
  cat >"$TMP_DIR/state.env.tmp" <<EOF
LAST_ACKED_ID=$LAST_ACKED_ID
FAIL_COUNT=$FAIL_COUNT
BARK_ALERTED_IDS='$BARK_ALERTED_IDS'
EOF
  chmod 600 "$TMP_DIR/state.env.tmp"
  $BB mv -f "$TMP_DIR/state.env.tmp" "$STATE_FILE"
}

save_bark_cache() {
  url_esc="$(printf '%s' "$1" | $BB sed "s/'/'\\\\''/g")"
  bearer_esc="$(printf '%s' "$2" | $BB sed "s/'/'\\\\''/g")"
  now_ts="$(date +%s)"
  cat >"$TMP_DIR/bark_cache.env.tmp" <<EOF
BARK_URL='$url_esc'
BARK_BEARER='$bearer_esc'
BARK_UPDATED_AT=$now_ts
EOF
  chmod 600 "$TMP_DIR/bark_cache.env.tmp"
  $BB mv -f "$TMP_DIR/bark_cache.env.tmp" "$BARK_CACHE_FILE"
  BARK_URL="$1"
  BARK_BEARER="$2"
  BARK_UPDATED_AT="$now_ts"
}

update_bark_from_json() {
  resp_json="$1"
  new_url="$(json_get "$resp_json" '$.bark.url')"
  new_bearer="$(json_get "$resp_json" '$.bark.bearer')"
  if [ -n "$new_url" ]; then
    if [ "$new_url" != "$BARK_URL" ] || [ "$new_bearer" != "$BARK_BEARER" ]; then
      save_bark_cache "$new_url" "$new_bearer"
      log_msg "[INFO] synced bark cache from server"
    else
      BARK_UPDATED_AT="$(date +%s)"
    fi
  fi
}

sync_server_config() {
  resp_file="$TMP_DIR/cfg.json"
  code="$($CURL -sS --max-time 10 -o "$resp_file" -w '%{http_code}' \
    -H "Authorization: Bearer $SMS_INGEST_TOKEN" \
    "$FLYTRAP_URL/v1/ingest/sms/config?device=$DEVICE_ID" 2>/dev/null || echo 000)"
  if [ "$code" = "200" ] && [ -f "$resp_file" ]; then
    body="$(cat "$resp_file")"
    ok="$(json_get "$body" '$.ok')"
    if [ "$ok" = "1" ] || [ "$ok" = "true" ]; then
      update_bark_from_json "$body"
      return 0
    fi
  fi
  return 1
}

init_cursor_if_needed() {
  if [ -f "$STATE_FILE" ] && [ -n "$LAST_ACKED_ID" ]; then
    return 0
  fi
  max_id="$(sql_ro "$SMS_DB" "SELECT COALESCE(MAX(_id), 0) FROM sms WHERE type = 1;")" || return 1
  case "$max_id" in
    ''|*[!0-9]*) return 1 ;;
  esac
  LAST_ACKED_ID="$max_id"
  FAIL_COUNT=0
  BARK_ALERTED_IDS=""
  save_state
  log_msg "[INFO] initialized cursor LAST_ACKED_ID=$LAST_ACKED_ID (skipped historical sms)"
}

resolve_slot_for_sub() {
  sub_id="$1"
  case "$sub_id" in
    ''|*[!0-9]*) sub_id=-1 ;;
  esac
  if [ "$sub_id" -ge 0 ] && [ -r "$TEL_DB" ]; then
    sim_id="$(sql_ro "$TEL_DB" "SELECT COALESCE(sim_id, -1) FROM siminfo WHERE _id = $sub_id LIMIT 1;")"
    case "$sim_id" in
      ''|*[!0-9-]*) sim_id=-1 ;;
    esac

    custom_label=""
    case "$sim_id" in
      0) custom_label="$SLOT_1_LABEL" ;;
      1) custom_label="$SLOT_2_LABEL" ;;
    esac
    if [ -n "$custom_label" ]; then
      echo "$custom_label"
      return
    fi

    raw_num="$(sql_ro "$TEL_DB" "SELECT COALESCE(number, '') FROM siminfo WHERE _id = $sub_id LIMIT 1;")"
    digits="$(printf '%s' "$raw_num" | $BB tr -cd '0-9')"
    case "$digits" in
      ????*)
        echo "${digits#${digits%????}}"
        return
        ;;
    esac

    if [ "$sim_id" -ge 0 ] 2>/dev/null; then
      echo "sim$((sim_id + 1))"
      return
    fi
    if [ "$sub_id" -gt 0 ] 2>/dev/null; then
      echo "sub$sub_id"
      return
    fi
  fi
  echo "sim"
}

id_already_alerted() {
  case ",$BARK_ALERTED_IDS," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

mark_id_alerted() {
  if [ -z "$BARK_ALERTED_IDS" ]; then
    BARK_ALERTED_IDS="$1"
  else
    BARK_ALERTED_IDS="$BARK_ALERTED_IDS,$1"
  fi
  save_state
}

send_bark_fallback() {
  sms_id="$1"
  slot="$2"
  if [ -z "$BARK_URL" ]; then
    log_msg "[WARN] bark cache empty, cannot send emergency push for sms_id=$sms_id"
    return 1
  fi
  if id_already_alerted "$sms_id"; then
    return 0
  fi

  dev_esc="$(escape_sql_str "$DEVICE_ID")"
  slot_esc="$(escape_sql_str "$slot")"
  bark_payload_file="$TMP_DIR/bark_payload.json"
  sql_ro "$SMS_DB" "SELECT json_object(
    'title', '[短信急救][$dev_esc·$slot_esc] ' || COALESCE(NULLIF(address, ''), '未知号码'),
    'body', COALESCE(NULLIF(body, ''), '(空短信)') || char(10) || char(10) || '(主端 Flytrap 暂未确认，恢复后自动补录)',
    'group', 'SMS-Fallback',
    'level', 'timeSensitive'
  ) FROM sms WHERE _id = $sms_id LIMIT 1;" >"$bark_payload_file"

  if [ ! -s "$bark_payload_file" ]; then
    return 1
  fi

  resp_file="$TMP_DIR/bark_resp.json"
  if [ -n "$BARK_BEARER" ]; then
    code="$($CURL -sS --max-time 10 -o "$resp_file" -w '%{http_code}' \
      -H 'Content-Type: application/json; charset=utf-8' \
      -H "Authorization: Bearer $BARK_BEARER" \
      --data-binary "@$bark_payload_file" \
      "$BARK_URL" 2>/dev/null || echo 000)"
  else
    code="$($CURL -sS --max-time 10 -o "$resp_file" -w '%{http_code}' \
      -H 'Content-Type: application/json; charset=utf-8' \
      --data-binary "@$bark_payload_file" \
      "$BARK_URL" 2>/dev/null || echo 000)"
  fi

  if [ "$code" = "200" ]; then
    mark_id_alerted "$sms_id"
    log_msg "[WARN] sent one-shot emergency Bark push for sms_id=$sms_id"
    return 0
  fi
  log_msg "[ERROR] emergency Bark push failed http=$code for sms_id=$sms_id"
  return 1
}

post_sms_to_flytrap() {
  sms_id="$1"
  slot="$2"
  dev_esc="$(escape_sql_str "$DEVICE_ID")"
  slot_esc="$(escape_sql_str "$slot")"
  payload_file="$TMP_DIR/ingest_payload.json"

  sql_ro "$SMS_DB" "SELECT json_object(
    'device', '$dev_esc',
    'smsId', _id,
    'from', COALESCE(NULLIF(trim(address), ''), 'unknown-sender'),
    'slot', '$slot_esc',
    'text', COALESCE(body, ''),
    'receivedAt', CASE
      WHEN COALESCE(date, 0) > 0 THEN date
      WHEN COALESCE(date_sent, 0) > 0 THEN date_sent
      ELSE strftime('%s','now') * 1000
    END
  ) FROM sms WHERE _id = $sms_id LIMIT 1;" >"$payload_file"

  if [ ! -s "$payload_file" ]; then
    return 1
  fi

  resp_file="$TMP_DIR/ingest_resp.json"
  code="$($CURL -sS --max-time 10 -o "$resp_file" -w '%{http_code}' \
    -H "Authorization: Bearer $SMS_INGEST_TOKEN" \
    -H 'Content-Type: application/json; charset=utf-8' \
    --data-binary "@$payload_file" \
    "$FLYTRAP_URL/v1/ingest/sms" 2>/dev/null || echo 000)"

  if [ "$code" = "200" ] && [ -f "$resp_file" ]; then
    resp_body="$(cat "$resp_file")"
    ok="$(json_get "$resp_body" '$.ok')"
    if [ "$ok" = "1" ] || [ "$ok" = "true" ]; then
      update_bark_from_json "$resp_body"
      return 0
    fi
  fi
  case "$code" in
    400|413|422)
      log_msg "[ERROR] permanent ingest error sms_id=$sms_id http=$code; skipping"
      return 2
      ;;
  esac
  log_msg "[WARN] ingest failed sms_id=$sms_id http=$code"
  return 1
}

process_pending() {
  if ! ids="$(sql_ro "$SMS_DB" "SELECT _id FROM sms WHERE type = 1 AND _id > $LAST_ACKED_ID ORDER BY _id ASC LIMIT 50;")"; then
    FAIL_COUNT=$((FAIL_COUNT + 1))
    save_state
    log_msg "[WARN] sqlite query failed fails=$FAIL_COUNT"
    return 1
  fi
  [ -n "$ids" ] || return 0

  for sms_id in $ids; do
    case "$sms_id" in
      ''|*[!0-9]*) continue ;;
    esac
    sub_id="$(sql_ro "$SMS_DB" "SELECT COALESCE(sub_id, -1) FROM sms WHERE _id = $sms_id LIMIT 1;" || echo -1)"
    slot="$(resolve_slot_for_sub "$sub_id")"

    rc=0
    post_sms_to_flytrap "$sms_id" "$slot" || rc=$?
    case "$rc" in
      0)
        LAST_ACKED_ID="$sms_id"
        FAIL_COUNT=0
        save_state
        log_msg "[INFO] acked sms_id=$sms_id slot=$slot"
        ;;
      2)
        LAST_ACKED_ID="$sms_id"
        FAIL_COUNT=0
        save_state
        continue
        ;;
      *)
        FAIL_COUNT=$((FAIL_COUNT + 1))
        save_state
        if [ "$FAIL_COUNT" -ge "$BARK_FAIL_THRESHOLD" ]; then
          # Alert once for every currently queued un-alerted SMS, without advancing LAST_ACKED_ID.
          for pending_id in $ids; do
            case "$pending_id" in
              ''|*[!0-9]*) continue ;;
            esac
            [ "$pending_id" -le "$LAST_ACKED_ID" ] && continue
            if ! id_already_alerted "$pending_id"; then
              p_sub="$(sql_ro "$SMS_DB" "SELECT COALESCE(sub_id, -1) FROM sms WHERE _id = $pending_id LIMIT 1;" || echo -1)"
              p_slot="$(resolve_slot_for_sub "$p_sub")"
              send_bark_fallback "$pending_id" "$p_slot" || true
            fi
          done
        fi
        return 1
        ;;
    esac
  done
  return 0
}

compute_backoff() {
  if [ "$FAIL_COUNT" -le 0 ]; then
    echo "$POLL_FALLBACK_SEC"
    return
  fi
  delay="$RETRY_BASE_SEC"
  step=1
  while [ "$step" -lt "$FAIL_COUNT" ] && [ "$delay" -lt "$RETRY_MAX_SEC" ]; do
    delay=$((delay * 2))
    step=$((step + 1))
  done
  [ "$delay" -gt "$RETRY_MAX_SEC" ] && delay="$RETRY_MAX_SEC"
  echo "$delay"
}

start_inotify_watcher() {
  cat >"$POKE_SCRIPT" <<EOF
#!/system/bin/sh
if [ -f "$PID_FILE" ]; then
  p="\$(cat "$PID_FILE" 2>/dev/null)"
  [ -n "\$p" ] && kill -USR1 "\$p" 2>/dev/null
fi
EOF
  chmod 700 "$POKE_SCRIPT"
  $BB inotifyd "$POKE_SCRIPT" "$SMS_DB_DIR:cwynd" >/dev/null 2>&1 &
  echo $! >"$INO_PID_FILE"
}

ensure_inotify_watcher() {
  ino_pid=""
  if [ -f "$INO_PID_FILE" ]; then
    ino_pid="$(cat "$INO_PID_FILE" 2>/dev/null || true)"
  fi
  if [ -n "$ino_pid" ] && kill -0 "$ino_pid" 2>/dev/null; then
    return 0
  fi
  if [ -n "$ino_pid" ]; then
    log_msg "[WARN] inotifyd (pid=$ino_pid) exited, respawning"
  fi
  start_inotify_watcher
}

echo $$ >"$PID_FILE"
WAKE_PENDING=0
SLEEP_PID=""

trap 'WAKE_PENDING=1; [ -n "$SLEEP_PID" ] && kill "$SLEEP_PID" 2>/dev/null' USR1
trap '
  [ -f "$INO_PID_FILE" ] && kill "$(cat "$INO_PID_FILE" 2>/dev/null)" 2>/dev/null
  rm -f "$PID_FILE" "$INO_PID_FILE"
  exit 0
' INT TERM

log_msg "[INFO] flytrap-sms shell daemon starting device=$DEVICE_ID url=$FLYTRAP_URL"
init_cursor_if_needed || log_msg "[WARN] sqlite cursor init deferred, retrying in loop"
sync_server_config || true
start_inotify_watcher

while true; do
  WAKE_PENDING=0
  ensure_inotify_watcher
  now_ts="$(date +%s)"
  if [ $((now_ts - BARK_UPDATED_AT)) -ge "$CONFIG_REFRESH_SEC" ]; then
    sync_server_config || true
  fi

  if ! init_cursor_if_needed; then
    FAIL_COUNT=$((FAIL_COUNT + 1))
    log_msg "[WARN] sqlite cursor init failed fails=$FAIL_COUNT"
    wait_sec="$(compute_backoff)"
  elif process_pending; then
    wait_sec="$POLL_FALLBACK_SEC"
  else
    wait_sec="$(compute_backoff)"
  fi

  if [ "$WAKE_PENDING" = "0" ]; then
    sleep "$wait_sec" &
    SLEEP_PID=$!
    wait "$SLEEP_PID" 2>/dev/null || true
    SLEEP_PID=""
  else
    # Small debounce when woken during a DB transaction.
    sleep 1
  fi
done
