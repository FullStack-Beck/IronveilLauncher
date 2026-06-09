# ⚒ Project Ironveil — Game Launcher

A cross-platform Electron launcher for Project Ironveil. Matches the parchment/forge aesthetic of the web portal, with Supabase auth, live dev updates, roadmap progress, and a role-gated game launch button.

---

## Features

- **Custom frameless window** with drag titlebar and macOS-style traffic-light controls
- **Supabase auth** (sign in / create account) with persistent session across restarts
- **Role-gated Launch button** — only `developer` and `admin` accounts see it
- **Game detection** — auto-searches common install paths, or browse manually
- **Dev Scrolls** — live dev updates from Supabase (realtime subscribed)
- **Codex** — collapsible roadmap showing task group progress
- **Playtest status badge** — live open/soon/closed indicator

---

## Quick Start

```bash
# 1 — Install dependencies
npm install

# 2 — Run in development
npm start
```

> Requires Node.js 18+ and npm.

---

## Building Distributable Installers

### Windows (.exe installer)
```bash
npm run build:win
# Output: dist/Project Ironveil Setup 0.1.0.exe
```

### macOS (.dmg)
```bash
npm run build:mac
# Output: dist/Project Ironveil-0.1.0.dmg
```

### Both platforms
```bash
npm run build:all
```

> **Note:** Building a Mac `.dmg` requires running the command on a Mac.  
> **Note:** Code signing is optional for internal use; add your Apple/Windows certs in `package.json` `build.mac.identity` / `build.win.certificateFile` when releasing publicly.

---

## Project Structure

```
ironveil-launcher/
├── src/
│   ├── main.js          ← Electron main process (window, IPC, game launch)
│   ├── preload.js       ← Secure IPC bridge to renderer
│   └── renderer/
│       └── index.html   ← The entire launcher UI
├── assets/
│   ├── icon.png         ← 512×512 app icon (add yours)
│   ├── icon.ico         ← Windows icon
│   └── icon.icns        ← Mac icon
└── package.json
```

---

## Granting Game Access

The launch button only shows for users with `role = 'developer'` or `role = 'admin'` in your Supabase `profiles` table. Grant access via the **Admin Portal → Members** page on the web.

---

## Adding Your Icons

Place these files in `/assets/` before building:
- `icon.png` — 512×512px PNG (used as base)
- `icon.ico` — Windows multi-size ICO (can convert from PNG at [icoconvert.com](https://icoconvert.com))
- `icon.icns` — macOS icon set (use `iconutil` on Mac or an online converter)

---

## Supabase Config

The Supabase URL and anon key are already set to the Ironveil project in `src/renderer/index.html`. If you ever rotate the key, update it there.

Session tokens are stored locally via Electron's `app.getPath('userData')` — no browser localStorage used.
