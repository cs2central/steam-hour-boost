<div align="center">

# Steam Hour Boost

**Steam hour booster with a modern web UI**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Discord](https://img.shields.io/discord/698303277766410240?color=5865F2&label=Discord&logo=discord&logoColor=white)](https://discord.gg/cs2central)
[![Website](https://img.shields.io/badge/Website-cs2central.gg-58a6ff?logo=google-chrome&logoColor=white)](https://cs2central.gg)
[![GitHub release](https://img.shields.io/github/v/release/cs2central/steam-hour-boost?include_prereleases&label=Release)](https://github.com/cs2central/steam-hour-boost/releases)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://hub.docker.com)

Companion app for [steam-authenticator-linux](https://github.com/cs2central/steam-authenticator-linux). Run 24/7 on your homeserver to idle Steam games and accumulate playtime.

[Features](#features) • [Quick Start](#quick-start) • [Documentation](#usage) • [Discord](https://discord.gg/cs2central)

</div>

> **Disclaimer**: This software is provided for educational and personal use only. Using automated tools may violate Steam's Terms of Service. The developers are not responsible for any account restrictions, suspensions, or bans. Use at your own risk.

---

## Screenshots

<div align="center">
  <img src="https://raw.githubusercontent.com/cs2central/steam-hour-boost/main/docs/screenshot.webp" alt="Hour Boost Dashboard" width="100%">
  <br>
  <em>Dashboard - Monitor all your accounts at a glance</em>
  <br><br>
  <img src="https://raw.githubusercontent.com/cs2central/steam-hour-boost/main/docs/screenshot3.webp" alt="Hour Boost Activity Logs" width="100%">
  <br>
  <em>Activity Logs - Real-time console output and status updates</em>
  <br><br>
  <img src="https://raw.githubusercontent.com/cs2central/steam-hour-boost/main/docs/screenshot2.webp" alt="Hour Boost Settings" width="100%">
  <br>
  <em>Settings - Configure defaults and manage your data</em>
</div>

---

## Features

| Feature | Description |
|---------|-------------|
| **Multi-Account** | Manage unlimited Steam accounts simultaneously |
| **Web Dashboard** | Clean, modern dark-themed interface |
| **MAFile Import** | Import Steam Guard files via folder picker or ZIP |
| **Auto 2FA** | Automatic Steam Guard using `shared_secret` |
| **32 Games/Account** | Idle multiple games at once per account |
| **Persona Status** | Appear Online, Away, or Invisible while idling |
| **Auto-Reconnect** | Automatically reconnects on disconnection |
| **Docker Ready** | One-command deployment with Docker Compose |
| **Persistent State** | Resumes idling after restart |

---

## Quick Start

### Docker (Recommended)

```bash
# Clone the repository
git clone https://github.com/cs2central/steam-hour-boost.git
cd steam-hour-boost

# Start with Docker Compose
docker-compose up -d

# Open in browser
open http://localhost:8869
```

### Manual Installation

```bash
# Prerequisites: Node.js 18+
npm install
npm start
```

Then open **http://localhost:8869** and create your admin account.

---

## Usage

### 1. Initial Setup

On first launch, create an admin account to secure the web interface.

### 2. Import MAFiles

MAFiles contain your Steam Guard authenticator data (`shared_secret`). Import them from:

- **Folder picker** - Select a directory containing `.maFile` files
- **ZIP upload** - Upload a ZIP archive with `.maFile` files

> Export MAFiles from [steam-authenticator-linux](https://github.com/cs2central/steam-authenticator-linux) or Steam Desktop Authenticator.

### 3. Add Steam Accounts

1. Navigate to **Accounts**
2. Click **Add Account**
3. Enter Steam credentials
4. Link an MAFile for automatic 2FA
5. Configure games to idle (default: CS2)
6. Set your preferred persona status

### 4. Start Idling

Click **Start** on individual accounts or use **Start All** from the dashboard.

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8869` | Web UI port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` | Database directory |
| `MAFILES_DIR` | `./mafiles` | MAFiles storage |
| `SESSION_SECRET` | *(random)* | Session encryption key |

---

## Common Game IDs

| Game | App ID |
|------|--------|
| Counter-Strike 2 | `730` |
| Dota 2 | `570` |
| Team Fortress 2 | `440` |
| Rust | `252490` |
| PUBG | `578080` |
| GTA V | `271590` |
| Apex Legends | `1172470` |
| Rocket League | `252950` |

---

## Docker Compose

```yaml
version: '3.8'

services:
  steam-hour-boost:
    build: .
    container_name: steam-hour-boost
    restart: unless-stopped
    ports:
      - "8869:8869"
    volumes:
      - ./data:/app/data
      - ./mafiles:/app/mafiles
    environment:
      - NODE_ENV=production
      - TZ=UTC
```

---

## API Reference

<details>
<summary><strong>Authentication</strong></summary>

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/setup` | Create initial admin account |
| POST | `/api/login` | Login |
| POST | `/api/logout` | Logout |

</details>

<details>
<summary><strong>Accounts</strong></summary>

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/accounts` | List all accounts |
| POST | `/api/accounts` | Create account |
| PUT | `/api/accounts/:id` | Update account |
| DELETE | `/api/accounts/:id` | Delete account |
| POST | `/api/accounts/:id/start` | Start idling |
| POST | `/api/accounts/:id/stop` | Stop idling |
| POST | `/api/accounts/start-all` | Start all accounts |
| POST | `/api/accounts/stop-all` | Stop all accounts |

</details>

<details>
<summary><strong>MAFiles</strong></summary>

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/mafiles` | List MAFiles |
| POST | `/api/mafiles/import/content` | Import MAFile content |
| POST | `/api/mafiles/import/zip` | Import from ZIP |
| POST | `/api/mafiles/:id/link/:accountId` | Link to account |
| DELETE | `/api/mafiles/:id` | Delete MAFile |

</details>

<details>
<summary><strong>Dashboard & Settings</strong></summary>

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dashboard` | Get dashboard data |
| GET | `/api/settings` | Get settings |
| PUT | `/api/settings` | Update settings |
| GET | `/health` | Health check |

</details>

---

## Security

- **Credential Encryption**: Steam passwords and secrets are encrypted at rest using AES-256-GCM with PBKDF2 key derivation (100k iterations)
- **Web UI Authentication**: Protected by bcrypt-hashed passwords
- **Rate Limiting**: Built-in protection against brute force attacks
- **Account Lockout**: Automatic lockout after failed Steam login attempts
- **Secure Export**: Encrypted backups with custom password protection

**For production deployment:**
- Use a reverse proxy with HTTPS (nginx, Caddy)
- Set a strong `SESSION_SECRET`
- Restrict network access to trusted IPs
- Keep your admin password secure - it's used to derive the encryption key

---

## Troubleshooting

<details>
<summary><strong>"Steam Guard code required"</strong></summary>

- Ensure you've linked an MAFile with a valid `shared_secret`
- Verify the MAFile belongs to the correct Steam account

</details>

<details>
<summary><strong>"Invalid password"</strong></summary>

- Double-check Steam credentials
- Check if Steam has temporarily locked the account

</details>

<details>
<summary><strong>Account stuck on "Connecting"</strong></summary>

- Check internet connectivity
- Steam servers may be experiencing issues
- Try restarting the service

</details>

<details>
<summary><strong>Auto-reconnect not working</strong></summary>

- Check activity logs for error messages
- Maximum 10 reconnect attempts with 30s+ delays

</details>

---

## Community

<div align="center">

[![Discord](https://img.shields.io/badge/Join%20our-Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/cs2central)
[![Website](https://img.shields.io/badge/Visit-Website-58a6ff?style=for-the-badge&logo=google-chrome&logoColor=white)](https://cs2central.gg)
[![GitHub](https://img.shields.io/badge/View%20on-GitHub-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/cs2central/steam-hour-boost)

</div>

---

## Disclaimer

This software is provided "as is" without warranty of any kind. By using this software, you acknowledge and agree that:

1. **Terms of Service**: Using automated tools to idle games may violate Steam's Terms of Service. Valve may take action against accounts found to be using such tools, including but not limited to warnings, suspensions, or permanent bans.

2. **No Liability**: The developers, contributors, and maintainers of this project are not responsible for any consequences resulting from the use of this software, including but not limited to:
   - Account restrictions or bans
   - Loss of games, items, or achievements
   - VAC or game bans
   - Any other penalties imposed by Valve or game publishers

3. **No Affiliation**: This project is not affiliated with, endorsed by, or connected to Valve Corporation, Steam, or any game publishers. All trademarks are the property of their respective owners.

4. **Personal Use**: This software is intended for educational and personal use only. Use responsibly and at your own risk.

5. **Security**: While credentials are encrypted, you are responsible for securing your system and keeping your data safe.

---

## License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

<div align="center">

Made with :heart: by [CS2 Central](https://cs2central.gg)

</div>
