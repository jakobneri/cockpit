#!/bin/bash

# Cockpit NAS Client v6.0.0
# Optimized for Synology NAS (Docker/Container Manager)

DB_URL="${DB_URL:-http://localhost:3001}"
HOSTNAME="${HOSTNAME:-$(hostname)}"
INTERVAL="${INTERVAL:-15}"

# Detect Host paths (Synology Fix)
PROC_PATH="/proc"
[ -d "/host/proc" ] && PROC_PATH="/host/proc"
SYS_PATH="/sys"
[ -d "/host/sys" ] && SYS_PATH="/host/sys"

log() { echo "[$(date +'%H:%M:%S')] $1"; }

log "Starting Cockpit NAS Agent on $HOSTNAME"
log "Target API: $DB_URL"
log "Using proc path: $PROC_PATH"

# Detect System Info
MODEL="Synology NAS"
if [ -f "$PROC_PATH/device-tree/model" ]; then
    MODEL=$(cat "$PROC_PATH/device-tree/model" | tr -d '\0')
fi

# Auto-detect main network interface
IFACE=$(ip route | grep default | awk '{print $5}' | head -1)
[ -z "$IFACE" ] && IFACE="eth0"
log "Monitoring interface: $IFACE"

# Initialize network counters
read -r rx1 tx1 < <(grep "$IFACE" "$PROC_PATH/net/dev" | awk '{print $2, $10}')
last_time=$(date +%s.%N)

# Initialize CPU counters
read -r _ u n s i io _ _ _ < "$PROC_PATH/stat"
prev_total=$((u+n+s+i+io))
prev_idle=$((i+io))

# Initialize Update Timer
LAST_UPDATE=$(date +%s)

get_active_jobs() {
    local jobs="[]"
    # 1. Check for rsync
    if pgrep -x "rsync" > /dev/null; then
        jobs=$(echo "$jobs" | jq -c '. += [{"name": "Rsync Transfer", "status": "Active", "started": "Now"}]')
    fi
    # 2. Check for Hyper Backup (Synology)
    if pgrep -f "synobackup" > /dev/null; then
        jobs=$(echo "$jobs" | jq -c '. += [{"name": "Hyper Backup", "status": "Running", "started": "System"}]')
    fi
    # 3. Check for Cloud Sync (Synology)
    if pgrep -f "cloud-sync" > /dev/null; then
        jobs=$(echo "$jobs" | jq -c '. += [{"name": "Cloud Sync", "status": "Syncing", "started": "System"}]')
    fi
    echo "$jobs"
}

get_drives_info() {
    local drives="[]"
    for disk in "$SYS_PATH"/block/sata* "$SYS_PATH"/block/sd* "$SYS_PATH"/block/nvme*; do
        if [ -d "$disk" ]; then
            local name=$(basename "$disk" 2>/dev/null)
            local state=$(cat "$disk/device/state" 2>/dev/null || echo "unknown")
            local size_kb=$(cat "$disk/size" 2>/dev/null || echo "0")
            local size=$((size_kb * 512))
            local model=$(cat "$disk/device/model" 2>/dev/null | tr -d ' ' || echo "Disk")
            local status="Healthy"
            if [ "$state" != "running" ]; then status="Failing"; fi
            
            if [[ "$name" == sata* ]] || [[ "$name" == sd* ]] || [[ "$name" == nvme* ]]; then
               drives=$(echo "$drives" | jq -c ". += [{\"name\": \"$name\", \"model\": \"$model\", \"state\": \"$state\", \"status\": \"$status\", \"size\": $size}]")
            fi
        fi
    done
    echo "$drives"
}

while true; do
    sleep $INTERVAL
    
    # Self-Update Check (8 hours = 28800 seconds)
    if [ $(($(date +%s) - LAST_UPDATE)) -gt 28800 ]; then
        log "Pulling Git Updates..."
        git pull origin main || true
        LAST_UPDATE=$(date +%s)
        # Restart agent to apply updates
        exec "$0" "$@"
    fi
    
    # 1. CPU Load
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

    # 2. Temperature
    temp=0
    if [ -f "$SYS_PATH/class/thermal/thermal_zone0/temp" ]; then
        temp=$(($(cat "$SYS_PATH/class/thermal/thermal_zone0/temp") / 1000))
    fi

    # 3. Memory
    mem_total=$(grep MemTotal "$PROC_PATH/meminfo" | awk '{printf "%.0f", $2 * 1024}')
    mem_avail=$(grep MemAvailable "$PROC_PATH/meminfo" | awk '{printf "%.0f", $2 * 1024}')
    
    # Fallback if MemAvailable is missing or 0
    if [ -z "$mem_avail" ] || [ "$mem_avail" -eq 0 ]; then
        mem_free=$(grep MemFree "$PROC_PATH/meminfo" | awk '{printf "%.0f", $2 * 1024}')
        mem_buf=$(grep "^Buffers:" "$PROC_PATH/meminfo" | awk '{printf "%.0f", $2 * 1024}')
        mem_cached=$(grep "^Cached:" "$PROC_PATH/meminfo" | awk '{printf "%.0f", $2 * 1024}')
        # Available roughly = Free + Buffers + Cached
        mem_avail=$((mem_free + mem_buf + mem_cached))
    fi

    mem_used=$((mem_total - mem_avail))
    mem_pct=$(echo "$mem_used $mem_total" | awk '{if($2>0) printf "%.1f", 100 * $1 / $2; else print "0.0"}')

    # 4. Network usage (kB/s)
    read -r rx2 tx2 < <(grep "$IFACE" "$PROC_PATH/net/dev" | awk '{print $2, $10}')
    now=$(date +%s.%N)
    diff=$(echo "$now $last_time" | awk '{print $1 - $2}')
    
    rx_sec=$(echo "$rx2 $rx1 $diff" | awk '{if($3>0) printf "%.1f", ($1 - $2) / 1024 / $3; else print "0.0"}')
    tx_sec=$(echo "$tx2 $tx1 $diff" | awk '{if($3>0) printf "%.1f", ($1 - $2) / 1024 / $3; else print "0.0"}')
    
    rx1=$rx2; tx1=$tx2; last_time=$now

    # 5. Storage (Root /volume1 is common on Synology)
    MNT_POINT="/"
    [ -d "/volume1" ] && MNT_POINT="/volume1"
    
    # Use -P for POSIX format to prevent line wrapping and ensure field order
    df_out=$(df -PB1 "$MNT_POINT" | tail -1)
    st_total=$(echo "$df_out" | awk '{print $2}')
    st_used=$(echo "$df_out" | awk '{print $3}')
    st_pct=$(echo "$df_out" | awk '{if($2>0) printf "%.1f", 100 * $3 / $2; else print "0.0"}')

    # 6. Active Jobs (v1.3.0)
    active_jobs=$(get_active_jobs)
    
    # 7. Physical Drives
    sys_drives=$(get_drives_info)

    # Construct JSON
    json_payload=$(cat <<EOF
{
  "hostname": "$HOSTNAME",
  "reported_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "system_info": {
    "model": "$MODEL",
    "platform": "synology",
    "version": "1.2.0"
  },
  "stats": {
    "cpu": { "load": $cpu_load, "temp": $temp },
    "memory": { "total": $mem_total, "used": $mem_used, "percent": $mem_pct },
    "network": { "rx_sec": $rx_sec, "tx_sec": $tx_sec },
    "storage": { "root": { "total": $st_total, "used": $st_used, "percent": $st_pct } },
    "uptime": $(awk '{print int($1)}' "$PROC_PATH/uptime"),
    "jobs": $active_jobs,
    "drives": $sys_drives
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
