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

2. Start the development server (runs Vite):
   ```bash
   npm run dev
   ```

3. Build for production (compiles Vite to `/dist`):
   ```bash
   npm run build
   ```

4. Start the production backend server (serves `/dist` and runs endpoints on port 3000):
   ```bash
   npm start
   ```

## Development
- All frontend visual changes are strictly located in `/src` (JS/CSS) and `index.html`.
- The backend dashboard polling API, command executor, and update webhook are located in `/server/index.js`.
- Make sure to **bump the version number** in `index.html` (and optionally `package.json`) whenever you push visual or functional updates.
