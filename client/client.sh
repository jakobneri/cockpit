#!/bin/bash

# Cockpit Native Client v3.3.20 (Bash Version)
# Zero-dependency monitoring for Linux / Raspberry Pi

DB_URL="${DB_URL:-http://localhost:3000}"
HOSTNAME=$(hostname)
INTERVAL=5

log() { echo "[$(date +'%H:%M:%S')] $1"; }

log "Starting Cockpit Bash Client on $HOSTNAME"
log "DB URL: $DB_URL"

# Initialize network counters
read -r _ rx1 _ _ _ _ _ _ tx1 _ < <(grep "eth0\|wlan0\|enp" /proc/net/dev | head -1 | sed 's/:/ /')
last_time=$(date +%s)

while true; do
    # 1. CPU Load
    read -r _ u n s i io _ _ _ < /proc/stat
    total=$((u+n+s+i+io))
    idle=$((i+io))
    
    sleep 1 # Measurment window
    
    read -r _ u n s i io _ _ _ < /proc/stat
    total2=$((u+n+s+i+io))
    idle2=$((i+io))
    
    cpu_load=$(( 100 * ( (total2 - total) - (idle2 - idle) ) / (total2 - total) ))
    
    # 2. Temperature
    temp=0
    if [ -f /sys/class/thermal/thermal_zone0/temp ]; then
        temp=$(($(cat /sys/class/thermal/thermal_zone0/temp) / 1000))
    fi

    # 3. Memory
    mem_total=$(grep MemTotal /proc/meminfo | awk '{print $2 * 1024}')
    mem_avail=$(grep MemAvailable /proc/meminfo | awk '{print $2 * 1024}')
    mem_used=$((mem_total - mem_avail))
    mem_pct=$(( 100 * mem_used / mem_total ))

    # 4. Network
    read -r _ rx2 _ _ _ _ _ _ tx2 _ < <(grep "eth0\|wlan0\|enp" /proc/net/dev | head -1 | sed 's/:/ /')
    now=$(date +%s)
    diff=$((now - last_time))
    rx_sec=$(( (rx2 - rx1) / diff ))
    tx_sec=$(( (tx2 - tx1) / diff ))
    rx1=$rx2; tx1=$tx2; last_time=$now

    # 5. Storage (Root)
    df_out=$(df -B1 / | tail -1)
    st_total=$(echo "$df_out" | awk '{print $2}')
    st_used=$(echo "$df_out" | awk '{print $3}')
    st_pct=$(echo "$df_out" | awk '{print $5}' | tr -d '%')

    # Construct JSON
    json_payload=$(cat <<EOF
{
  "hostname": "$HOSTNAME",
  "reported_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "system_info": {},
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
    curl -s -X POST "$DB_URL/rpc/report_client_metrics" \
        -H "Content-Type: application/json" \
        -H "Prefer: params=single-object" \
        -d "$json_payload" > /dev/null

    if [ $? -eq 0 ]; then
        log "✅ Reported metrics ($cpu_load% CPU, $mem_pct% RAM)"
    else
        log "❌ Reporting failed"
    fi

    sleep $((INTERVAL - 1))
done
