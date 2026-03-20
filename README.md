# 🛡️ Cockpit Hub v5.4.0
### The Ultimate Fleet Monitoring Dashboard for Raspberry Pi & Home Networks

Cockpit Hub is a distributed monitoring system designed for high-performance home labs. It provides real-time visibility into your Raspberry Pi fleet and network gateway (Fritz!Box) through a beautiful, glassmorphic dashboard.

---

## 🏗️ Architecture (V5 Stack)
Cockpit v5 follows a decoupled **Agent-Hub-Database** model:

1.  **Cockpit Hub**: An Express.js server serving the Vite/React-style frontend. It acts as the central API gateway and command center.
2.  **Cockpit Agents**: Low-footprint Node.js probes (like `archimedes-client`) that stream system metrics directly to the Hub.
3.  **Gateway Client**: A specialized probe that talks to **Fritz!Box** routers via TR-064 to fetch DSL sync, uptime, and system logs.
4.  **PostgREST & Postgres**: The high-performance data layer. PostgREST transforms your database into a RESTful API instantly.

---

## 🌟 Core Capabilities
- **Real-Time Fleet View**: Instant health checks of all connected nodes.
- **Deep History**: Interactive charts (Chart.js) showing CPU, Memory, and Network trends.
- **Gateway Intelligence**: Dedicated view for Fritz!Box status, including VPN activity and sync speeds.
- **Recursive Data Flattening**: Automatically handles nested JSON metrics for clean table displays.
- **Full-Width Raw Data**: A specialized high-density view for inspecting the entire database.
- **Smart Exports**: One-click XML data exports for any node, including system logs and uptime.
- **Hard-Reset Auto-Updater**: Intelligent "Self-Healing" logic that allows the Hub to keep itself in sync with the repository.

---

## 🛠️ Installation (Standard Hub + Db)
1.  **Clone & Build**:
    ```bash
    git clone https://github.com/jakobneri/cockpit.git
    cd cockpit && npm install && npx vite build
    ```
2.  **Prepare Database**:
    Ensure Postgres/PostgREST is running, then apply the schema:
    ```bash
    cat setup_v3.sql | docker exec -i cockpit-db psql -U cockpit_user -d cockpit
    ```
3.  **Start Stack**:
    ```bash
    pm2 start ecosystem.config.cjs
    ```

---

## 💡 Nice to Know Commands

### 🔄 The "Super Update" (Emergency Sync)
If the dashboard is out of sync or feels "stuck", run this to force a total repository reset:
```bash
git fetch origin && git reset --hard origin/main && npm install && npx vite build && pm2 restart all
```

### 🗄️ Database Maintenance
**Verify Client Connectivity**:
```bash
curl http://localhost:3001/clients?select=hostname,last_seen
```
**Wipe History (Emergency Cleanup)**:
```bash
# Deletes the metrics table for a specific host
docker exec -i cockpit-db psql -U cockpit_user -d cockpit -c "DROP TABLE metrics_your_node_name;"
```

### 📡 PM2 Fleet Management
- **View Logs**: `pm2 log cockpit-hub` or `pm2 log archimedes-client`
- **Monitor CPU**: `pm2 monit`
- **Save State**: `pm2 save` (Ensures startup on reboot)

---

## 🚀 Environment Variables (`.env`)
- `PORT`: Hub listening port (default `3000`)
- `DB_URL`: PostgREST API endpoint (default `http://localhost:3001`)
- `HUB_PASSWORD`: Token for admin tasks and agent authorization.

---
Made with ❤️ by Jakob Neri & Antigravity
**V5 Final Milestone Release**
