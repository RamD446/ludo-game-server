# Ludo Game Server

Standalone Socket.IO service for room creation, matchmaking, player
connections, and synchronization with the existing Ludo mobile client.

## Run locally

```bash
npm ci
npm start
```

The server listens on `process.env.PORT` (default `3001`) on all interfaces.
`GET /health` returns a JSON health check. Room state is in memory and is lost
when the process restarts.

Optional configuration:

- `PORT`: listening port; Render supplies this automatically.
- `CLIENT_ORIGIN`: comma-separated browser origins allowed by Socket.IO CORS.
  It may be omitted for the current cross-origin/native-client behavior.

To regenerate `public/player-names.json`, run `npm run generate:names`.

The server validates that online actions come from the connected current
player, that rolls and moves are valid for the latest published game state,
and forwards accepted actions to the room host. The existing game rules and
state transitions are still run by that host; this is not a fully
server-authoritative anti-cheat implementation.

## Render

Create a **Node** Web Service from this repository. Use:

- **Build Command:** `npm ci`
- **Start Command:** `npm start`
- **Health Check Path:** `/health`
- **Environment:** Node.js 20 or newer

Render sets `PORT`; do not hard-code it in the dashboard. Add `CLIENT_ORIGIN`
only if the browser app needs a restricted origin list. Use the public HTTPS
service URL in the mobile app; Socket.IO negotiates secure WebSocket transport
from that URL.

No credentials are required by this server. Keep deployment tokens and any
future secrets out of source control.
"# ludo-game-server" 
