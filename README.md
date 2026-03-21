# 🛡️ Cockpit Hub v5.5.0
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
To monitor multiple Fritz!Boxes, edit [cockpit.config.json](./cockpit.config.json):
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
3.  **Command**: `DB_URL="http://hub_ip:3000" bash client.sh`

#### B. Windows (PowerShell)
Native monitoring for Windows PCs.
1.  Copy [client/client.ps1](./client/client.ps1) to the target machine.
2.  **Command**: `$env:DB_URL="http://hub_ip:3000"; ./client.ps1`

#### C. Gateway Client (Node.js)
Specialized for Fritz!Box. Requires the `tr-064` library.
1.  **Command**: `pm2 start client/gateway-client.js --name "my-gateway"`
2.  **Required Envs**: `GATEWAY_IP`, `GATEWAY_USER`, `GATEWAY_PASS`.

---

## 🚀 Manual Configuration Checklist

| Task | File | Detail |
|------|------|--------|
| **DB Password** | `docker-compose.yml` | Update `POSTGRES_PASSWORD` and `PGRST_DB_URI`. |
| **Hub Password** | `server/index.js` (or ENV) | Set a strong `HUB_PASSWORD`. |
| **Trusted IPs** | `server/index.js` (or ENV) | Add your main PC IP to `HUB_TRUSTED_IPS` for easy access. |
| **Fritz!Box Auth** | `cockpit.config.json` | Ensure every gateway has the correct `admin` password. |
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
Made with ❤️ by Jakob Neri & Antigravity
**V5.5 Final Milestone Release**
