#!/bin/bash
# =============================================================================
# Cockpit NAS Agent — Synology (Docker/Container Manager)
# =============================================================================
# Monitoring agent optimised for Synology NAS devices running inside a Docker
# container. Reads host metrics via /host/proc and /host/sys bind-mounts,
# monitors active backup/sync jobs, checks drive health with smartctl, and
# POSTs a JSON snapshot to the Cockpit PostgREST endpoint every INTERVAL
# seconds. Self-updates from git every 8 hours.
#
# Environment variables:
#   DB_URL    — PostgREST base URL          (default: http://localhost:3001)
#   HOSTNAME  — Override reported hostname
#   INTERVAL  — Reporting interval (seconds) (default: 60)
# =============================================================================

# ── Configuration ─────────────────────────────────────────────────────────────
DB_URL="${DB_URL:-http://localhost:3001}"
HOSTNAME="${HOSTNAME:-$(hostname)}"
INTERVAL="${INTERVAL:-60}"

# ── Path Detection ────────────────────────────────────────────────────────────
# When running inside a container with bind-mounts, host /proc and /sys are
# available under /host/. Fall back to container-local paths otherwise.
PROC_PATH="/proc"
[ -d "/host/proc" ] && PROC_PATH="/host/proc"
SYS_PATH="/sys"
[ -d "/host/sys" ] && SYS_PATH="/host/sys"

# ── Logging ───────────────────────────────────────────────────────────────────
log() { echo "[$(date +'%H:%M:%S')] $1"; }

log "Starting Cockpit NAS Agent on $HOSTNAME"
log "Target API: $DB_URL | Interval: ${INTERVAL}s | proc: $PROC_PATH"

# ── System Info Detection ─────────────────────────────────────────────────────
MODEL="Synology NAS"
if [ -f "$PROC_PATH/device-tree/model" ]; then
    MODEL=$(cat "$PROC_PATH/device-tree/model" | tr -d '\0')
fi

# ── Initialization ────────────────────────────────────────────────────────────
# Detect primary network interface from the default route.
IFACE=$(ip route | grep default | awk '{print $5}' | head -1)
[ -z "$IFACE" ] && IFACE="eth0"
log "Monitoring interface: $IFACE"

# Seed network and CPU counters for the first delta calculation.
read -r rx1 tx1 < <(grep "$IFACE" "$PROC_PATH/net/dev" | awk '{print $2, $10}')
last_time=$(date +%s.%N)

read -r _ u n s i io _ _ _ < "$PROC_PATH/stat"
prev_total=$((u+n+s+i+io))
prev_idle=$((i+io))

# Timestamp of the last self-update check.
LAST_UPDATE=$(date +%s)

# ── Job Detection ─────────────────────────────────────────────────────────────
# Returns a JSON array of currently running Synology backup/sync processes.
get_active_jobs() {
    local jobs="[]"
    # 1. Check for rsync
    if pgrep -x "rsync" > /dev/null; then
        jobs=$(echo "$jobs" | jq -c '. += [{"name": "Rsync Transfer", "status": "Active"}]')
    fi
    # 2. Check for Hyper Backup (Synology)
    if pgrep -f "synobackup" > /dev/null; then
        jobs=$(echo "$jobs" | jq -c '. += [{"name": "Hyper Backup", "status": "Running"}]')
    fi
    # 3. Check for Cloud Sync (Synology)
    if pgrep -f "cloud-sync" > /dev/null; then
        jobs=$(echo "$jobs" | jq -c '. += [{"name": "Cloud Sync", "status": "Syncing"}]')
    fi
    # 4. Check for Synology RAID Scrubbing/Consistency check
    if [ -f "/proc/mdstat" ] && grep -q "resync=" /proc/mdstat; then
        jobs=$(echo "$jobs" | jq -c '. += [{"name": "RAID Resync", "status": "Repairing"}]')
    fi
    echo "$jobs"
}

# ── Drive Monitoring ──────────────────────────────────────────────────────────
# Returns a JSON array of block devices with model, size, state, and SMART health.
get_drive_monitoring() {
    local drives="[]"
    # Detect all block devices
    # remote use: "$SYS_PATH"/block/sata* "$SYS_PATH"/block/sd* "$SYS_PATH"/block/nvme*
    for disk in "$SYS_PATH"/block/sata* "$SYS_PATH"/block/sd* "$SYS_PATH"/block/nvme*; do
        if [ -d "$disk" ]; then
            local name=$(basename "$disk" 2>/dev/null)
            # Skip loop and ram devices if they got mixed in
            [[ "$name" == loop* ]] && continue
            [[ "$name" == ram* ]] && continue

            local state=$(cat "$disk/device/state" 2>/dev/null || echo "unknown")
            local size_kb=$(cat "$disk/size" 2>/dev/null || echo "0")
            local size=$((size_kb * 512))
            local model=$(cat "$disk/device/model" 2>/dev/null | tr -d ' ' || echo "Disk")
            
            # SMART Health Check (Our v6.0.0 feature)
            local status="Healthy"
            local dev_node="/dev/$name"
            if [ -e "$dev_node" ]; then
                if smartctl -H "$dev_node" | grep -q "FAILED"; then
                    status="Critical"
                elif ! smartctl -H "$dev_node" | grep -q "PASSED"; then
                    # Fallback to system state if smartctl fails or is inconclusive
                    [ "$state" != "running" ] && [ "$state" != "unknown" ] && status="Failing"
                fi
            fi
            
            drives=$(echo "$drives" | jq -c ". += [{\"device\": \"$name\", \"model\": \"$model\", \"status\": \"$status\", \"size\": $size, \"state\": \"$state\"}]")
        fi
    done
    echo "$drives"
}

# ── Main Loop ─────────────────────────────────────────────────────────────────
while true; do
    sleep $INTERVAL

    # Self-update every 8 hours — restarts the agent to pick up new code.
    if [ $(($(date +%s) - LAST_UPDATE)) -gt 28800 ]; then
        log "Checking for Git Updates..."
        git pull origin main || true
        LAST_UPDATE=$(date +%s)
        # Restart agent to apply updates
        exec "$0" "$@"
    fi

    # ── Metrics Collection ────────────────────────────────────────────────────
    # CPU — percentage used since the last sample
    read -r _ u n s i io _ _ _ < "$PROC_PATH/stat"
    total=$((u+n+s+i+io))
    idle=$((i+io))
    
    cpu_load=$(echo "$total $prev_total $idle $prev_idle" | awk '{
        diff_total = $1 - $2;
        diff_idle = $3 - $4;
        if (diff_total > 0) printf "%.1f", 100 * (diff_total - diff_idle) / diff_total;
        else print "0.0"
    }')
    prev_total=$total; prev_idle=$idle

    # Temperature — thermal_zone0 in °C (0 if unavailable)
    temp=0
    if [ -f "$SYS_PATH/class/thermal/thermal_zone0/temp" ]; then
        temp=$(($(cat "$SYS_PATH/class/thermal/thermal_zone0/temp") / 1000))
    fi

    # Memory — bytes total / used / percent (MemAvailable fallback for DSM)
    mem_total=$(grep MemTotal "$PROC_PATH/meminfo" | awk '{printf "%.0f", $2 * 1024}')
    mem_avail=$(grep MemAvailable "$PROC_PATH/meminfo" | awk '{printf "%.0f", $2 * 1024}')
    
    if [ -z "$mem_avail" ] || [ "$mem_avail" -eq 0 ]; then
        mem_free=$(grep MemFree "$PROC_PATH/meminfo" | awk '{printf "%.0f", $2 * 1024}')
        mem_buf=$(grep "^Buffers:" "$PROC_PATH/meminfo" | awk '{printf "%.0f", $2 * 1024}')
        mem_cached=$(grep "^Cached:" "$PROC_PATH/meminfo" | awk '{printf "%.0f", $2 * 1024}')
        mem_avail=$((mem_free + mem_buf + mem_cached))
    fi

    mem_used=$((mem_total - mem_avail))
    mem_pct=$(echo "$mem_used $mem_total" | awk '{if($2>0) printf "%.1f", 100 * $1 / $2; else print "0.0"}')

    # Network — kB/s delta since last sample
    read -r rx2 tx2 < <(grep "$IFACE" "$PROC_PATH/net/dev" | awk '{print $2, $10}')
    now=$(date +%s.%N)
    diff=$(echo "$now $last_time" | awk '{print $1 - $2}')
    
    rx_sec=$(echo "$rx2 $rx1 $diff" | awk '{if($3>0) printf "%.1f", ($1 - $2) / 1024 / $3; else print "0.0"}')
    tx_sec=$(echo "$tx2 $tx1 $diff" | awk '{if($3>0) printf "%.1f", ($1 - $2) / 1024 / $3; else print "0.0"}')
    
    rx1=$rx2; tx1=$tx2; last_time=$now

    # Storage — /volume1 preferred on Synology, falls back to root
    MNT_POINT="/"
    [ -d "/volume1" ] && MNT_POINT="/volume1"
    
    df_out=$(df -PB1 "$MNT_POINT" | tail -1)
    st_total=$(echo "$df_out" | awk '{print $2}')
    st_used=$(echo "$df_out" | awk '{print $3}')
    st_pct=$(echo "$df_out" | awk '{if($2>0) printf "%.1f", 100 * $3 / $2; else print "0.0"}')

    # Jobs and drive health (NAS-specific)
    active_jobs=$(get_active_jobs)
    drive_monitoring=$(get_drive_monitoring)

    # ── Build and POST payload ────────────────────────────────────────────────
    json_payload=$(cat <<EOF
{
  "hostname": "$HOSTNAME",
  "reported_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "system_info": {
    "model": "$MODEL",
    "platform": "synology",
    "version": "6.8.1"
  },
  "stats": {
    "cpu": { "load": $cpu_load, "temp": $temp },
    "memory": { "total": $mem_total, "used": $mem_used, "percent": $mem_pct },
    "network": { "rx_sec": $rx_sec, "tx_sec": $tx_sec },
    "storage": { 
        "root": { "total": $st_total, "used": $st_used, "percent": $st_pct },
        "drives": $drive_monitoring
    },
    "uptime": $(awk '{print int($1)}' "$PROC_PATH/uptime"),
    "jobs": $active_jobs
  }
}
EOF
)

    # POST to DB
    status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$DB_URL/rpc/report_client_metrics" \
        -H "Content-Type: application/json" \
        -H "Prefer: params=single-object" \
        -d "$json_payload")

    if [ "$status" -eq 200 ] || [ "$status" -eq 204 ] || [ "$status" -eq 201 ]; then
        log "✅ Reported: $cpu_load% CPU, $mem_pct% RAM"
    else
        log "❌ Failed (HTTP $status)"
    fi
done
