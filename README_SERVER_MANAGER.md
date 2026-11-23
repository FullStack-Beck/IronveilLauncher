# Ironveil Launcher — Dedicated Server Manager MVP

This build adds a **Servers** page to the existing Electron launcher.

## Included

- Create, edit, select, and delete local server profiles.
- Save a dedicated-server executable path.
- Start one dedicated-server process at a time and stop it from the launcher.
- Capture stdout/stderr in the launcher (last 500 lines per profile).
- Persist server profiles and private server entries in the existing `ironveil-config.json` store.
- Add/remove private servers by display name, address, and port.
- Save a `private` or `public` visibility preference per local profile.
- Keep the Electron preload API allowlisted; no raw `ipcRenderer` is exposed.

## Setup

1. Replace the launcher's existing `renderer/index.html`, `main.js`, and `preload.js` with the files in this folder (preserve the launcher's existing folder layout: `renderer/index.html` beside `main.js` and `preload.js`).
2. Start the launcher and open **Servers**.
3. Create a profile and locate a built dedicated-server executable.
4. Save the profile, then start it. The process output appears in the Process Output panel.

## Important current limitations

- The Unity dedicated-server build does not yet exist / has not been integrated. The launcher can manage a server executable, but cannot create one.
- The profile argument template currently proposes `-port`, `-serverName`, `-maxPlayers`, and `-world` plus Unity's `-batchmode -nographics`. **The Unity server bootstrap must parse and implement these options** before the profile settings are authoritative. The profile UI explicitly exposes editable arguments and documents this dependency.
- A process marked Running means the OS process is alive; it does not yet prove FishNet is listening or accepting clients.
- The public visibility preference is stored locally only. No public directory registration, heartbeat, official-server directory, or Supabase backend table has been implemented.
- Private server entries are stored locally but are not yet injected into the Unity lobby's `IServerDirectory`.
- The game launch button has not yet been connected to the local server address or server discovery.
- Stopping currently sends a normal process kill; a graceful server shutdown command is a future Unity-side integration.
- Closing the launcher window stops its managed server process, matching the launcher's current process ownership model.

## Next Unity integration steps

1. Add a dedicated-server build target and bootstrap argument parser for the profile arguments.
2. Ensure headless startup skips XR and all local-player/camera-only systems.
3. Configure FishNet transport port from the profile and expose a server-ready signal.
4. Add a shared server-entry DTO used by the launcher and Unity client.
5. Pass localhost server details and saved private entries into the game, then merge them with official and public directory results.
6. Implement public directory registration/heartbeat and graceful shutdown after the server process is stable.

## Validation performed

- `node --check main.js`
- `node --check preload.js`
- Extracted inline renderer JavaScript and ran `node --check` on it.

The Electron app itself was not launched in this environment, and no Unity server executable was available for an end-to-end process test.
