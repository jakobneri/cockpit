# Pi Cockpit Dashboard

A modern, low-resource web dashboard for monitoring your Raspberry Pi operations. Built with Node.js, Express, and Vanilla JS/CSS (Vite).

## Features
- **System Metrics**: Real-time line charts tracking CPU, RAM, and Temperature.
- **Storage Monitoring**: View disk usage across local root partitions and automatic SMB/NFS network drive detection.
- **Top Processes**: Keep an eye on the highest CPU and Memory consuming processes at all times.
- **Services Management**: Start, Stop, and Restart essential services like Unifi OS, Nextcloud, and Pi-hole directly from the dashboard.
- **Auto-Updates**: Built-in 60-second polling to auto-deploy new code pushed to the `main` branch.

## Installation & Running Locally

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server (runs Vite for frontend testing):
   ```bash
   npm run dev
   ```

3. Build for production (compiles frontend to `/dist`):
   ```bash
   npm run build
   ```

### Running with PM2 (Recommended for Raspberry Pi)
To keep the dashboard running in the background persistently (even after reboots), use `pm2`.

1. Install PM2 globally:
   ```bash
   sudo npm install -g pm2
   ```

2. Start the backend server with PM2:
   ```bash
   pm2 start server/index.js --name "pi-cockpit"
   ```

3. Save the PM2 process list to start on boot:
   ```bash
   pm2 save
   pm2 startup
   ```

4. View Dashboard Logs:
   ```bash
   pm2 logs pi-cockpit
   ```

5. View Dashboard Status / Info:
   ```bash
   pm2 status
   pm2 show pi-cockpit
   ```

### Running without PM2 (for testing)
   ```bash
   npm start
   ```

## Development
- All frontend visual changes are strictly located in `/src` (JS/CSS) and `index.html`.
- The backend dashboard polling API, command executor, and update webhook are located in `/server/index.js`.
- Make sure to **bump the version number** in `index.html` (and optionally `package.json`) whenever you push visual or functional updates.
