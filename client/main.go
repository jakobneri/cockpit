package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Cockpit Go Client v3.3.20
// High-performance, low-RAM monitoring agent

var (
	dbURL    = getEnv("DB_URL", "http://localhost:3000")
	interval = 5 * time.Second
	hostname, _ = os.Hostname()
)

type Metrics struct {
	Hostname   string                 `json:"hostname"`
	ReportedAt string                 `json:"reported_at"`
	SystemInfo map[string]interface{} `json:"system_info"`
	Stats      Stats                  `json:"stats"`
}

type Stats struct {
	CPU     CPUMetrics    `json:"cpu"`
	Memory  MemoryMetrics `json:"memory"`
	Network NetworkMetrics `json:"network"`
	Storage StorageMetrics `json:"storage"`
	Uptime  int64         `json:"uptime"`
}

type CPUMetrics struct {
	Load int `json:"load"`
	Temp int `json:"temp"`
}

type MemoryMetrics struct {
	Total   uint64 `json:"total"`
	Used    uint64 `json:"used"`
	Percent int    `json:"percent"`
}

type NetworkMetrics struct {
	RxSec uint64 `json:"rx_sec"`
	TxSec uint64 `json:"tx_sec"`
}

type StorageMetrics struct {
	Root VolumeMetrics `json:"root"`
}

type VolumeMetrics struct {
	Total   uint64 `json:"total"`
	Used    uint64 `json:"used"`
	Percent int    `json:"percent"`
}

func main() {
	fmt.Printf("[%s] Starting Cockpit Go Client on %s\n", time.Now().Format("15:04:05"), hostname)
	fmt.Printf("[%s] DB URL: %s\n", time.Now().Format("15:04:05"), dbURL)

	for {
		metrics := collectMetrics()
		reportToDB(metrics)
		time.Sleep(interval)
	}
}

func collectMetrics() Metrics {
	stats := Stats{}

	// CPU & Memory (simplified)
	if runtime.GOOS == "linux" {
		stats.CPU.Load = getCPULoadLinux()
		stats.Memory = getMemoryLinux()
	} else if runtime.GOOS == "windows" {
		stats.CPU.Load = getCPULoadWindows()
		stats.Memory = getMemoryWindows()
	}

	stats.Uptime = getUptime()

	return Metrics{
		Hostname:   hostname,
		ReportedAt: time.Now().UTC().Format(time.RFC3339),
		SystemInfo: make(map[string]interface{}),
		Stats:      stats,
	}
}

func reportToDB(m Metrics) {
	data, _ := json.Marshal(m)
	req, _ := http.NewRequest("POST", dbURL+"/rpc/report_client_metrics", bytes.NewBuffer(data))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Prefer", "params=single-object")

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("[%s] ❌ Reporting failed: %v\n", time.Now().Format("15:04:05"), err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		fmt.Printf("[%s] ✅ Reported metrics (%d%% CPU, %d%% RAM)\n", time.Now().Format("15:04:05"), m.Stats.CPU.Load, m.Stats.Memory.Percent)
	} else {
		fmt.Printf("[%s] ❌ Reporting failed: %s\n", time.Now().Format("15:04:05"), resp.Status)
	}
}

// OS-specific helpers (Stubbed for brevity in this example, use actual syscalls/proc/cmd for production)
func getCPULoadLinux() int {
    out, _ := exec.Command("sh", "-c", "top -bn1 | grep 'Cpu(s)' | awk '{print $2 + $4}'").Output()
    val, _ := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
    return int(val)
}

func getMemoryLinux() MemoryMetrics {
    out, _ := exec.Command("free", "-b").Output()
    lines := strings.Split(string(out), "\n")
    parts := strings.Fields(lines[1])
    total, _ := strconv.ParseUint(parts[1], 10, 64)
    used, _ := strconv.ParseUint(parts[2], 10, 64)
    return MemoryMetrics{Total: total, Used: used, Percent: int(used * 100 / total)}
}

func getCPULoadWindows() int {
    out, _ := exec.Command("wmic", "cpu", "get", "loadpercentage").Output()
    lines := strings.Split(string(out), "\n")
    if len(lines) > 1 {
        val, _ := strconv.Atoi(strings.TrimSpace(lines[1]))
        return val
    }
    return 0
}

func getMemoryWindows() MemoryMetrics {
    out, _ := exec.Command("wmic", "os", "get", "totalvisiblememorysize,freephysicalmemory", "/format:list").Output()
    lines := strings.Split(string(out), "\n")
    var total, free uint64
    for _, l := range lines {
        if strings.HasPrefix(l, "TotalVisibleMemorySize") {
            total, _ = strconv.ParseUint(strings.TrimSpace(strings.Split(l, "=")[1]), 10, 64)
        }
        if strings.HasPrefix(l, "FreePhysicalMemory") {
            free, _ = strconv.ParseUint(strings.TrimSpace(strings.Split(l, "=")[1]), 10, 64)
        }
    }
    total *= 1024
    used := total - (free * 1024)
    return MemoryMetrics{Total: total, Used: used, Percent: int(used * 100 / total)}
}

func getUptime() int64 {
    if runtime.GOOS == "linux" {
        out, _ := os.ReadFile("/proc/uptime")
        parts := strings.Fields(string(out))
        upt, _ := strconv.ParseFloat(parts[0], 64)
        return int64(upt)
    }
    return 0
}

func getEnv(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return fallback
}
