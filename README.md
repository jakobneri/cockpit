# 🛡️ Cockpit Hub v6.8.0
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

### 1. Database & API Layer (The Engine)
The core of Cockpit is a **PostgreSQL** database and a **PostgREST** API layer.

#### 🚀 Quick Start: Database
Follow these steps to get the database environment running:

1.  **Start Containers**:
    ```bash
    docker-compose up -d
    ```
2.  **Verify**: Run `docker ps` to ensure `cockpit-db` and `cockpit-api` are "Up".
3.  **Initialize Schema**:
    ```bash
    cat setup_v3.sql | docker exec -i cockpit-db psql -U cockpit_user -d cockpit
    ```

---

#### ⚠️ Troubleshooting: Common Issues

**A. Docker containers missing or redownloading?**
This usually means your external storage (USB stick) is not mounted.
1.  Check mounts: `lsblk` (look for `sda1` or your USB disk).
2.  If missing, mount it: `sudo mount /dev/sda1 /mnt/docker-data` (or your config path).
3.  Restart Docker: `sudo systemctl restart docker`.

**B. Read-only filesystem error?**
Raspberry Pis sometimes flip to read-only mode if there's a power dip or SD card error.
1.  Remount as Read-Write: `sudo mount -o remount,rw /`.
2.  Restart services: `sudo systemctl restart docker`.

---

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

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Hub listening port | `3000` |
| `DB_URL` | Internal PostgREST URL | `http://localhost:3001` |
| `JWT_SECRET` | Secret for signing JWTs — **set a strong random value!** | ephemeral (resets on restart) |
| `INITIAL_ADMIN_PASSWORD` | Password for the auto-created admin account | `Admin1234!` |

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

---

## 🔐 Auth Setup — Step-by-Step Tutorial

> Everything below assumes you are **SSH'd into the Pi** (or server) that runs Cockpit Hub.
> The tutorial covers a fresh install as well as upgrading an existing deployment.

---

### Step 1 — SSH into your Hub

```bash
ssh archimedes@YOUR_PI_IP
# e.g.
ssh archimedes@192.168.188.23
```

Navigate to the Cockpit directory:

```bash
cd ~/cockpit
```

---

### Step 2 — Pull the latest code & install dependencies

```bash
git pull origin main
npm install
```

> `npm install` picks up the new packages (`jose`, `bcryptjs`, `otplib`, `qrcode`).
> The old `pg` package is no longer required — the hub talks to PostgreSQL exclusively through PostgREST.

---

### Step 3 — Create the `hub_users` table

Run the auth migration against the Cockpit database.
The Docker container is called `cockpit-db`:

```bash
cat setup_auth.sql | docker exec -i cockpit-db psql -U cockpit_user -d cockpit
```

Expected output:

```
CREATE TABLE
GRANT
GRANT
NOTIFY
```

Verify the table was created:

```bash
docker exec -i cockpit-db psql -U cockpit_user -d cockpit -c "\d hub_users"
```

You should see columns: `id`, `username`, `password_hash`, `role`, `totp_secret`, `totp_enabled`, `created_at`.

---

### Step 4 — Generate a strong JWT secret

Sessions are signed with a secret key. If it is not set, the hub generates an ephemeral one and **all sessions are lost on every restart**.

```bash
# Generate a 32-byte random secret and copy the output
node -e "const {randomBytes}=require('crypto'); console.log(randomBytes(32).toString('hex'))"
```

Save the output — you'll use it in the next step.

---

### Step 5 — Set environment variables in PM2

Open the PM2 ecosystem file:

```bash
nano root.config.cjs
```

Find the `hub` app entry and add `JWT_SECRET` to `env`:

```js
{
  name: 'cockpit-hub',
  script: 'server/index.js',
  env: {
    PORT:                    3000,
    DB_URL:                  'http://localhost:3001',
    JWT_SECRET:              'PASTE_YOUR_GENERATED_SECRET_HERE',
    INITIAL_ADMIN_PASSWORD:  'ChooseAStrongPassword123!'   // only used on first boot
  }
}
```

Save and exit (`Ctrl+O`, `Enter`, `Ctrl+X`).

> **Tip:** `INITIAL_ADMIN_PASSWORD` is only read once — when the `hub_users` table is empty.
> You can remove it from the config after the first login.

---

### Step 6 — Build the frontend & restart the hub

```bash
npm run build
pm2 restart cockpit-hub
```

Watch the startup log:

```bash
pm2 logs cockpit-hub --lines 30
```

On a fresh install you will see:

```
⚠️  Default admin created → username: admin  password: ChooseAStrongPassword123!
⚠️  Change this password immediately via /users !
✅  Auth DB ready
🚀  cockpit hub v6.8.1 | 🌐 http://localhost:3000 | 🔐 JWT auth (PostgREST backend)
```

---

### Step 7 — First login

Open `http://YOUR_PI_IP:3000` in your browser.

You will see the **Sign In** screen. Log in with:

| Field    | Value                            |
|----------|----------------------------------|
| Username | `admin`                          |
| Password | the value you set in Step 5      |

> Passwords are **SHA-256 hashed in the browser** before being sent.
> The server stores only a `bcrypt(sha256)` hash — your plaintext password is never transmitted.

---

### Step 8 — Change the default password immediately

1. Click your username chip in the **top-right corner** of the dashboard.
2. Select **Account & Security**.
3. Fill in **Current Password**, **New Password**, and **Confirm New Password**.
4. Click **Update Password**.

---

### Step 9 — Create additional users

1. Click the **Users** tab in the top navigation bar (visible to admins only).
2. Click **+ New User**.
3. Fill in username, password, and choose a role:

| Role | Can view fleet | Can run commands | Can manage users |
|------|:-:|:-:|:-:|
| `viewer` | ✅ | ❌ | ❌ |
| `operator` | ✅ | ✅ | ❌ |
| `admin` | ✅ | ✅ | ✅ |

---

### Step 10 — (Optional) Enable Two-Factor Authentication

TOTP works with any standard authenticator app (Google Authenticator, Authy, 1Password, etc.).

1. Click your username chip → **Account & Security**.
2. Under **Two-Factor Authentication**, click **Enable 2FA**.
3. Scan the QR code with your authenticator app.
4. Enter the 6-digit code to confirm and activate.

From the next login you will be asked for your TOTP code after entering your password.

**Admin: reset a user's 2FA**
If a user loses their authenticator device, go to **Users**, find the user, and click **Reset 2FA**. They can re-enroll on their next login.

---

### Step 11 — (Optional) Update the Manual Update command

The `/api/admin/update` endpoint now requires a valid JWT instead of the old plain password.
Use the dashboard button (**↑ Update Hub** in the Hub Services section) or run:

```bash
# From the Pi itself (still works as before via the local apiFetch flow)
# Trigger via the UI — no raw curl call needed anymore.
```

---

### Troubleshooting

**`hub_users table missing` in logs**
→ You skipped Step 3. Run the migration:
```bash
cat setup_auth.sql | docker exec -i cockpit-db psql -U cockpit_user -d cockpit
```

**`JWT_SECRET not set — sessions reset on restart`**
→ You skipped Step 4/5. Add `JWT_SECRET` to your PM2 config and `pm2 restart cockpit-hub`.

**Locked out (forgot password)**
→ Reset it directly via Docker:
```bash
# 1. Generate a new SHA-256 hash of your chosen password in Node:
node -e "const c=require('crypto'); console.log(c.createHash('sha256').update('MyNewPassword!').digest('hex'))"

# 2. Paste the hex output into the next command as SHA256_HEX:
docker exec -i cockpit-db psql -U cockpit_user -d cockpit -c \
  "UPDATE hub_users SET password_hash = crypt('SHA256_HEX_HERE', gen_salt('bf',12)) WHERE username='admin';"
```
> **Note:** The above uses pgcrypto's `crypt()`. Alternatively, generate the bcrypt hash in Node and `UPDATE` with the raw hash string.

**`Invalid or expired token` after restart**
→ `JWT_SECRET` is not persisted — see Step 4/5.

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
| **JWT Secret** | `root.config.cjs` (ENV) | Set a strong random `JWT_SECRET` — see auth tutorial Step 4. |
| **Auth Migration** | `setup_auth.sql` | Run once to create `hub_users` table — see auth tutorial Step 3. |
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

### 🛠️ Maintenance & Tips

-   **Manual Update**: Use the **↑ Update Hub** button in the Hub Services section of the dashboard (requires `operator` or `admin` role). Or via curl with a valid JWT:
    ```bash
    curl -X POST http://localhost:3000/api/admin/update \
      -H "Authorization: Bearer YOUR_JWT_TOKEN"
    ```
-   **Debug DB**: Check PostgREST and RPC visibility.
    ```bash
    node debug-db.js
    ```

---
Made with ❤️ by Jakob Neri & Antigravity
**V6.8.0 Redesigned Analytics (Interactive Hub Charts & Node Breakdown)**
**V6.7.0 Global Fleet Storage (Doughnut Chart) & Improved Readability**
**V6.6.2 Sidebar Cleanup & Status Box removal**
**V6.6.1 Node 18 Compatibility Fix (Vite 5 pinning)**
**V6.6.0 Improved Update Workflow, UI Cleanup & About Page Info**
**V6.5.0 Compute Section, Global Fleet Graphs & UI Refinement**
**V6.4.0 (Windows adaptation, Hub Info & Auto-update fixes)**
**V6.3.0 Info Subpage, Text Nav & Uptime Display**
**V6.2.0 Left Sidebar layout, Muted Glows & Pi Hub Rewrite**
**V6.1.0 Liquid Glass Theme**
**V6.0.0 Major UI Rework & Pi Hub**
