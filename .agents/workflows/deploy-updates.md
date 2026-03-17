---
description: How to deploy updates to the Pi Cockpit Dashboard
---
Whenever you make functional or visual changes to the Pi Cockpit dashboard, you MUST ALWAYS remember to bump the version number before finishing your task.

1. **Update index.html Version**:
   - Open `index.html`
   - Locate the `<h1>` tag containing `<span class="version-tag">vX.X.X</span>`
   - Increment the patch, minor, or major version based on the size of your changes. (e.g. `v1.2.1` -> `v1.2.2`)

2. **Update package.json Version** (Optional but recommended):
   - Open `package.json`
   - Update the `"version": "X.X.X"` field to match.

3. **Commit and Push**:
   - Run `git add .`
   - Run `git commit -m "Your descriptive message"`
   - Run `git push`

The Pi will automatically pull the changes after you push them!
