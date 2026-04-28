# =============================================================================
# Cockpit Native Client — Windows Agent (PowerShell)
# =============================================================================
# Lightweight monitoring agent for Windows. Collects system metrics via WMI/CIM
# and POSTs a JSON snapshot to the Cockpit PostgREST endpoint every $INTERVAL
# seconds. All configuration is via environment variables.
#
# Environment variables:
#   DB_URL    — PostgREST base URL          (default: http://localhost:3001)
#   INTERVAL  — Reporting interval (seconds) (default: 30)
# =============================================================================

# ── Configuration ─────────────────────────────────────────────────────────────
$DB_URL   = if ($env:DB_URL)   { $env:DB_URL }   else { "http://localhost:3001" }
$INTERVAL = if ($env:INTERVAL) { [int]$env:INTERVAL } else { 30 }
$HOSTNAME = [System.Net.Dns]::GetHostName()

# ── Logging ───────────────────────────────────────────────────────────────────
function Get-Timestamp { Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ" }
function Log($msg) { Write-Host "[$((Get-Date).ToString('HH:mm:ss'))] $msg" }

Log "Starting Cockpit PowerShell Client on $HOSTNAME"
Log "DB URL: $DB_URL | Interval: ${INTERVAL}s"

# ── Initialization ────────────────────────────────────────────────────────────
# Seed network counters for the first delta calculation.
$netStats = netstat -e | Select-String "Bytes"
$rx1      = [int64]($netStats -split '\s+')[1]
$tx1      = [int64]($netStats -split '\s+')[2]
$lastTime = Get-Date

# ── Main Loop ─────────────────────────────────────────────────────────────────
while ($true) {
    Start-Sleep -Seconds $INTERVAL

    # CPU — average load percentage across all cores
    $cpu = Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average |
           Select-Object -ExpandProperty Average
    $cpu = [Math]::Round($cpu, 1)

    # Memory — total / used / percent
    $osInfo   = Get-CimInstance Win32_OperatingSystem
    $totalMem = [int64]$osInfo.TotalVisibleMemorySize * 1024
    $freeMem  = [int64]$osInfo.FreePhysicalMemory * 1024
    $usedMem  = $totalMem - $freeMem
    $memPct   = [Math]::Round(($usedMem / $totalMem) * 100, 1)

    # Network — kB/s delta since last sample
    $netStats = netstat -e | Select-String "Bytes"
    $rx2      = [int64]($netStats -split '\s+')[1]
    $tx2      = [int64]($netStats -split '\s+')[2]
    $now      = Get-Date
    $diff     = ($now - $lastTime).TotalSeconds
    $rxSec    = if ($diff -gt 0) { [Math]::Round(($rx2 - $rx1) / $diff / 1024, 1) } else { 0 }
    $txSec    = if ($diff -gt 0) { [Math]::Round(($tx2 - $tx1) / $diff / 1024, 1) } else { 0 }
    $rx1 = $rx2; $tx1 = $tx2; $lastTime = $now

    # Storage — C: drive (bytes)
    $vol    = Get-Volume -DriveLetter C | Select-Object Size, SizeRemaining
    $stTotal = $vol.Size
    $stUsed  = $vol.Size - $vol.SizeRemaining
    $stPct   = [Math]::Round(($stUsed / $stTotal) * 100, 1)

    # System model (WMI)
    $model = (Get-CimInstance Win32_ComputerSystem).Model
    if (!$model) { $model = "Windows PC" }

    # ── Build and POST payload ────────────────────────────────────────────────
    $payload = @{
        hostname    = $HOSTNAME
        reported_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        system_info = @{
            model    = $model
            platform = "windows"
            version  = "5.0.0"
        }
        stats = @{
            cpu     = @{ load = $cpu; temp = 0 }
            memory  = @{ total = $totalMem; used = $usedMem; percent = $memPct }
            network = @{ rx_sec = $rxSec; tx_sec = $txSec }
            storage = @{ root = @{ total = $stTotal; used = $stUsed; percent = $stPct } }
            uptime  = [int](New-TimeSpan -Start (Get-CimInstance Win32_OperatingSystem).LastBootUpTime).TotalSeconds
        }
    }

    $json = $payload | ConvertTo-Json -Compress

    try {
        $null = Invoke-RestMethod -Uri "$DB_URL/rpc/report_client_metrics" `
            -Method Post `
            -ContentType "application/json" `
            -Headers @{ "Prefer" = "params=single-object" } `
            -Body $json
        Log "✅ Reported metrics ($cpu% CPU, $memPct% RAM)"
    } catch {
        Log "❌ Reporting failed: $($_.Exception.Message)"
    }
}
