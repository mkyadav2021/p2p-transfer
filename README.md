# P2P File Transfer

A browser-based peer-to-peer file transfer app. Files travel directly between two browsers — no file ever touches a server.

**Live demo:** https://mkyadav2021.github.io/p2p-transfer

---

## How it works

Most file-sharing tools upload your file to a server, then let the other person download it. This app skips that entirely.

When you pick a file, a small signaling server helps the two browsers find each other and exchange connection details (this is called the WebRTC handshake). Once that's done, a direct peer-to-peer data channel opens between the browsers and the file is streamed through it — chunk by chunk — with no server involvement. The signaling server's job is finished the moment the connection is established.

```
Sender browser ──[WebSocket]──▶ Signaling server ◀──[WebSocket]── Receiver browser
        │                                                                 │
        └─────────────────── WebRTC data channel ─────────────────────────┘
                              (direct, no server)
```

The WebRTC data channel is encrypted by default via DTLS (the same trust model as HTTPS). Rooms can optionally be password-protected — the server only stores a SHA-256 hash of the password and never sees the file.

---

## Features

- Peer-to-peer transfer — file bytes never reach the server
- Works across different networks and devices via STUN NAT traversal
- Password-protected rooms
- Real-time progress bar and transfer speed
- Shareable link + QR code for the receiver
- Drag-and-drop or click-to-browse file selection
- Dark mode (follows system preference)
- Mobile-friendly layout

---

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | HTML, CSS, vanilla JavaScript |
| P2P transport | WebRTC (`RTCPeerConnection`, `RTCDataChannel`) |
| NAT traversal | Google STUN (`stun.l.google.com:19302`) |
| Signaling server | Node.js + `ws` (WebSocket library) |
| Server hosting | [Render](https://render.com) (free tier) |
| Client hosting | GitHub Pages |

No build step, no frameworks, no bundler. Everything runs directly in the browser.

---

## Local development

**Prerequisites:** Node.js 18+

```bash
# 1. Clone the repo
git clone https://github.com/mkyadav2021/p2p-transfer.git
cd p2p-transfer

# 2. Start the signaling server
cd server
npm install
npm start
# Listening on ws://localhost:8080

# 3. Serve the frontend (new terminal, from project root)
cd docs
python3 -m http.server 3000
# Open http://localhost:3000
```

Open `http://localhost:3000` in two tabs. Pick a file in one, paste the link in the other.

> `navigator.clipboard` requires a secure context. Use `http://localhost:3000` (not `file://`) so the Copy button works.

---

## Project structure

```
p2p-transfer/
├── server/
│   ├── index.js          # WebSocket signaling server
│   └── package.json
└── docs/                 # Static frontend (served by GitHub Pages)
    ├── index.html
    ├── style.css
    └── app.js
```

---

## Architecture notes

**Signaling server** (`server/index.js`) — handles only connection setup:
- `create-room` — generates a room ID, stores `sha256(password)` if provided
- `join-room` — verifies password hash, admits receiver, notifies sender
- Forwards `sdp-offer`, `sdp-answer`, and `ice-candidate` messages between peers
- Cleans up rooms when either peer disconnects
- Ping/pong heartbeat every 30s to keep connections alive on free hosting

**Frontend** (`docs/app.js`) — all WebRTC and file transfer logic:
- Detects sender vs. receiver mode from the URL hash (`#ROOMID`)
- Sender creates an `RTCDataChannel`, generates an SDP offer, sends file metadata then the file in 64 KB chunks
- Backpressure via `bufferedAmountLowThreshold` prevents memory blowup on large files
- Receiver collects chunks into an array, assembles a `Blob` on completion, triggers download via `URL.createObjectURL`
- ICE candidates are queued client-side until `setRemoteDescription` completes to avoid race conditions

---

## Deploying your own instance

**Signaling server → Render**
1. Connect this repo to [Render](https://render.com)
2. New Web Service → Root directory: `server`, Build: `npm install`, Start: `npm start`
3. Copy the deployed URL (e.g. `https://your-app.onrender.com`)

**Frontend → GitHub Pages**
1. Update `WS_URL` in `docs/app.js` with your Render URL (`wss://your-app.onrender.com`)
2. Push to GitHub
3. Settings → Pages → Branch: `main`, Folder: `/docs`

> Free Render instances sleep after 15 minutes of inactivity. The first connection after sleep takes ~30 seconds.
