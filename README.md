# 🛡️ Cockpit Hub v5.6.9
### The Ultimate Fleet Monitoring Dashboard for Raspberry Pi & Home Networks

Cockpit Hub is a distributed monitoring system designed for high-performance home labs. It provides real-time visibility into your Raspberry Pi fleet and network gateway (Fritz!Box) through a beautiful, glassmorphic dashboard.

---

## 🏗️ Architecture (V5 Stack)
Cockpit v5 follows a decoupled **Agent-Hub-Database** model:

1.  **Cockpit Hub**: An Express.js server serving the Vite/React-style frontend. It acts as the central API gateway and command center.
2.  **Cockpit Agents**: Low-footprint Node.js or Native probes (PowerShell/Bash) that stream system metrics directly to the Hub.
3.  **Gateway Client**: A specialized probe that talks to **Fritz!Box** routers via TR-064 to fetch DSL sync, uptime, and system logs.
4.  **PostgREST & Postgres**: The high-performance data layer. PostgREST transforms your database into a RESTful API instantly.

---

## 🛠️ Full Setup Tutorial

### 1. Database & API Layer (The Engine)
The core of Cockpit is a **PostgreSQL** database and a **PostgREST** API layer.

#### A. Start with Docker
We recommend using the provided [docker-compose.yml](./docker-compose.yml) to launch the database stack:

```bash
docker-compose up -d
```

#### B. Initialize Schema
Apply the [setup_v3.sql](./setup_v3.sql) to create the `clients` registry and the metric-reporting functions:

```bash
cat setup_v3.sql | docker exec -i cockpit-db psql -U cockpit_user -d cockpit
```

---

### 2. Hub Setup (The Command Center)
The Hub serves the dashboard and manages the authentication for your agents.

#### A. Installation
```bash
git clone https://github.com/jakobneri/cockpit.git
cd cockpit
npm install
npx vite build
```

#### B. Configuration
The Hub is managed via [root.config.cjs](./root.config.cjs). You MUST set these environment variables in your command or PM2 config:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Hub listening port | `3000` |
| `DB_URL` | Internal PostgREST URL | `http://localhost:3001` |
| `HUB_PASSWORD` | Access token for the dashboard | `test123` |
| `HUB_TRUSTED_IPS` | Comma-separated list of IPs to skip password | `127.0.0.1` |

#### C. Gateway Registry
To monitor multiple Fritz!Boxes, edit [config.json](./config.json):
```json
{
  "gateways": [
    {
      "ip": "192.168.188.1",
      "user": "admin",
      "password": "YOUR_FRITZBOX_PASSWORD"
    }
  ]
}
```

#### D. Start with PM2
```bash
pm2 start root.config.cjs
```

---

### 3. Standalone Client Setup (The Agents)
Agents can be installed on ANY machine in your network (Servers, Desktops, Pis).

#### A. Linux / Raspberry Pi (Bash)
No Node.js required! Uses `curl` and `sysfs`.
1.  Copy [client/client.sh](./client/client.sh) to the target machine.
2.  Set `DB_URL` env var and run.
3.  **Command**: `DB_URL="http://hub_ip:3001" bash client.sh`

#### B. Windows (PowerShell)
Native monitoring for Windows PCs.
1.  Copy [client/client.ps1](./client/client.ps1) to the target machine.
2.  **Command**: `$env:DB_URL="http://hub_ip:3001"; ./client.ps1`

#### C. Gateway Client (Node.js)
Specialized for Fritz!Box. Requires the `tr-064` library.
1.  **Command**: `pm2 start client/gateway-client.js --name "my-gateway"`
2.  **Required Envs**: `GATEWAY_IP`, `GATEWAY_USER`, `GATEWAY_PASS`.

---

## ⚡ Standalone Client Setup (No Hub Required locally)
If you want to monitor a machine that is NOT running the Hub, follow these steps to install only the probe.

### 1. Identify your Hub's Public Address
You will need the IP address or Domain of the machine where your Cockpit Hub is running (e.g., `http://192.168.188.23:3000`).

### 2. Choose your Agent
Download only the necessary file to the machine you want to monitor:

#### A. Linux / Raspberry Pi (Recommended)
1. **Download**: [client.sh](https://raw.githubusercontent.com/jakobneri/cockpit/main/client/client.sh)
2. **Setup**:
   ```bash
   # Make executable
   chmod +x client.sh
   # Run with your Hub URL
   DB_URL="http://YOUR_HUB_IP:3001" ./client.sh
   ```
3. **Run in Background**: `pm2 start ./client.sh --name "my-node" --interpreter bash`

#### B. Windows Desktop
1. **Download**: [client.ps1](https://raw.githubusercontent.com/jakobneri/cockpit/main/client/client.ps1)
2. **Setup**: 
   - Open PowerShell as Administrator.
   - Run: `$env:DB_URL="http://YOUR_HUB_IP:3001"; ./client.ps1`

#### C. Dedicated Fritz!Box Gateway
1. **Requires Node.js**: `npm install tr-064`
2. **Setup**:
   ```bash
   export GATEWAY_IP="192.168.178.1"
   export GATEWAY_USER="admin"
   export GATEWAY_PASS="your_pass"
   export DB_URL="http://YOUR_HUB_IP:3001"
   node client/gateway-client.js
   ```

---

## 🚀 Manual Configuration Checklist

| Task | File | Detail |
|------|------|--------|
| **DB Password** | `docker-compose.yml` | Update `POSTGRES_PASSWORD` and `PGRST_DB_URI`. |
| **Hub Password** | `server/index.js` (or ENV) | Set a strong `HUB_PASSWORD`. |
| **Trusted IPs** | `server/index.js` (or ENV) | Add your main PC IP to `HUB_TRUSTED_IPS` for easy access. |
| **Fritz!Box Auth** | `config.json` | Ensure every gateway has the correct `admin` password. |
| **DB Persistence** | `docker-compose.yml` | Verify the `cockpit_db_data` volume is kept across restarts. |

---

## 📊 Maintenance & Utility

- **View Hub Logs**: `pm2 logs cockpit-hub`
- **Clean Registry**:
  ```sql
  DELETE FROM clients WHERE hostname = 'old-hostname';
  ```
- **Wipe Metric History**:
  ```sql
  DROP TABLE metrics_hostname_safe_name;
  ```

---

## 🔒 Branch Protection Rules

This repository enforces a **pull request policy** on the `master` branch:

- **Only the repository owner (`@jakobneri`) may push directly to `master`.**
- **All other contributors must open a pull request** — direct pushes from non-owners are blocked.

### How it works

1. **`CODEOWNERS`** (`.github/CODEOWNERS`): Designates `@jakobneri` as the required reviewer for all code changes.
2. **`enforce-pr-policy` workflow** (`.github/workflows/enforce-pr-policy.yml`): Runs on every push to `master` and fails if the pusher is not the repository owner.

### ⚙️ Required GitHub Settings (one-time setup by owner)

To fully enforce this policy, the owner must configure the following in **GitHub → Settings → Branches → Add branch protection rule**:

| Setting | Value |
|---|---|
| Branch name pattern | `master` |
| Require a pull request before merging | ✅ Enabled |
| Require approvals | ✅ 1 approval minimum |
| Dismiss stale pull request approvals | ✅ Recommended |
| Require review from Code Owners | ✅ Enabled |
| Require status checks to pass | ✅ Enabled → add `Enforce Pull Request Policy / Block Direct Push to Master` |
| Allow specified actors to bypass | `jakobneri` |
| Do not allow bypassing the above settings | ❌ Leave unchecked (so owner can bypass) |

With these settings applied, only `@jakobneri` can push directly or bypass the PR requirement.

---
Made with ❤️ by Jakob Neri & Antigravity
**V5.6.9 Final Milestone Release**
