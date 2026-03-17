# 🚀 Pi Cockpit v2.0.0

A highly performant, distributed, and beautiful monitoring dashboard for your Raspberry Pi server farm or homelab.

## 🌟 Features
- **Centralized Hub**: Monitor multiple servers from a single dashboard.
- **Zero-Dependency Agent**: Standalone "Lite" agent that reads directly from `/proc` and `/sys`.
- **Responsive UI**: Stunning Glassmorphism design that works on phones, tablets, and desktops.
- **Adaptive Interaction**: Real-time graphs and metrics only when you're watching.
- **Service Control**: Start/Stop/Restart services (Nextcloud, Unifi, Pi-hole) across your fleet.

---

## 🛠️ Installation & Setup

### 1. The Hub (Central Dashboard)
Install this on your main Raspberry Pi (the one connected to your screen or public web).

```bash
git clone https://github.com/jakobneri/cockpit.git
cd cockpit
npm install
npm run build
pm2 start ecosystem.config.cjs --only cockpit-hub
```

### 2. The Agents (Machine Probes)
Run this on **every** machine you want to monitor.

#### A. Full Installation (Recommended for Hub machine)
```bash
pm2 start ecosystem.config.cjs --only cockpit-agent
```

#### B. Client-Only Installation (Wget way)
*Perfect for remote servers where you don't want the full source code.*
```bash
mkdir cockpit-agent && cd cockpit-agent
wget https://raw.githubusercontent.com/jakobneri/cockpit/main/agent/agent.js
wget https://raw.githubusercontent.com/jakobneri/cockpit/main/ecosystem.config.cjs
# Edit ecosystem.config.cjs to set your Hub IP, then:
pm2 start ecosystem.config.cjs --only cockpit-agent
```

---

## 📡 Architecture (How it works)
V2.0 uses a **Push-based Hub & Spoke** model:
1. **Agents** gather metrics locally every 5s using ultra-fast `/proc` reads.
2. **Agents** `POST` their data to the **Hub**.
3. **Hub** saves the data in memory and serves the Dashboard UI.
4. **Dashboard** lets you click into any server for detailed live graphs and controls.

---

## ⚙️ Service Control
To allow the Agent to control services without a password, add this to your sudoers:
`echo '$USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl' | sudo tee /etc/sudoers.d/cockpit-services`

---

## 🔄 Updating from v1.x to v2.0
If you are already running an older version, follow these steps to migrate:

1. **Stop old processes**: `pm2 stop all`
2. **Pull latest code**: `cd ~/cockpit && git pull`
3. **Re-install & Build**: `npm install && npm run build`
4. **Setup Hub**: `pm2 start ecosystem.config.cjs --only cockpit-hub`
5. **Setup Local Agent**: `pm2 start ecosystem.config.cjs --only cockpit-agent`
6. **Cleanup & Save**: `pm2 delete pi-cockpit && pm2 save`

---
Made with ❤️ by Jakob Neri
