#!/bin/bash

# Cockpit Native Client v6.0.0 (Bash Version)
# Zero-dependency monitoring for Linux / Raspberry Pi

DB_URL="${DB_URL:-http://localhost:3001}"
HOSTNAME=$(hostname)
INTERVAL=5

log() { echo "[$(date +'%H:%M:%S')] $1"; }

# Auto-detect System Info
MODEL="Linux Node"
if [ -f /proc/device-tree/model ]; then
    MODEL=$(cat /proc/device-tree/model | tr -d '\0')
elif [ -f /sys/class/dmi/id/product_name ]; then
    MODEL=$(cat /sys/class/dmi/id/product_name)
fi

log "Starting Cockpit Bash Client on $HOSTNAME ($MODEL)"
log "DB URL: $DB_URL"

# Initialize network counters
IFACE=$(ip route | grep default | awk '{print $5}' | head -1)
[ -z "$IFACE" ] && IFACE="eth0"

read -r rx1 tx1 < <(grep "$IFACE" /proc/net/dev | awk '{print $2, $10}')
last_time=$(date +%s.%N)

# Initialize CPU counters
read -r _ u n s i io _ _ _ < /proc/stat
prev_total=$((u+n+s+i+io))
prev_idle=$((i+io))

while true; do
    sleep $INTERVAL
    
    # 1. CPU Load (Delta over INTERVAL)
    read -r _ u n s i io _ _ _ < /proc/stat
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
    if [ -f /sys/class/thermal/thermal_zone0/temp ]; then
        temp=$(($(cat /sys/class/thermal/thermal_zone0/temp) / 1000))
    fi

    # 3. Memory
    mem_total=$(grep MemTotal /proc/meminfo | awk '{printf "%.0f", $2 * 1024}')
    mem_avail=$(grep MemAvailable /proc/meminfo | awk '{printf "%.0f", $2 * 1024}')
    mem_used=$((mem_total - mem_avail))
    mem_pct=$(echo "$mem_used $mem_total" | awk '{if($2>0) printf "%.1f", 100 * $1 / $2; else print "0.0"}')

    # 4. Network usage (kB/s)
    read -r rx2 tx2 < <(grep "$IFACE" /proc/net/dev | awk '{print $2, $10}')
    now=$(date +%s.%N)
    diff=$(echo "$now $last_time" | awk '{print $1 - $2}')
    
    rx_sec=$(echo "$rx2 $rx1 $diff" | awk '{if($3>0) printf "%.1f", ($1 - $2) / 1024 / $3; else print "0.0"}')
    tx_sec=$(echo "$tx2 $tx1 $diff" | awk '{if($3>0) printf "%.1f", ($1 - $2) / 1024 / $3; else print "0.0"}')
    
    rx1=$rx2; tx1=$tx2; last_time=$now

    # 5. Storage (Root)
    df_out=$(df -B1 / | tail -1)
    st_total=$(echo "$df_out" | awk '{print $2}')
    st_used=$(echo "$df_out" | awk '{print $3}')
    st_pct=$(echo "$df_out" | awk '{if($2>0) printf "%.1f", 100 * $3 / $2; else print "0.0"}')

    # Construct JSON
    json_payload=$(cat <<EOF
{
  "hostname": "$HOSTNAME",
  "reported_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "system_info": {
    "model": "$MODEL",
    "platform": "linux",
    "version": "4.0.4"
  },
  "stats": {
    "cpu": { "load": $cpu_load, "temp": $temp },
    "memory": { "total": $mem_total, "used": $mem_used, "percent": $mem_pct },
    "network": { "rx_sec": $rx_sec, "tx_sec": $tx_sec },
    "storage": { "root": { "total": $st_total, "used": $st_used, "percent": $st_pct } },
    "uptime": $(awk '{print int($1)}' /proc/uptime)
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
        log "✅ Reported metrics ($cpu_load% CPU, $mem_pct% RAM)"
    else
        log "❌ Reporting failed (HTTP $status)"
    fi
done
