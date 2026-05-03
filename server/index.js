//okay buddy, this journey will teach me alot. this is the starting point of my journey!.
//Node.js

const { WebSocketServer } = require("ws");
const crypto = require("crypto");

function hashPassword(password) {
  if (!password) return null;
  return crypto.createHash("sha256").update(password).digest("hex");
}

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

// rooms: roomId -> { sender: ws, receiver: ws | null }
const rooms = new Map();

function generateRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function send(ws, data) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

wss.on("connection", (ws) => {
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "create-room": {
        let roomId;
        do {
          roomId = generateRoomId();
        } while (rooms.has(roomId));

        rooms.set(roomId, { sender: ws, receiver: null, passwordHash: hashPassword(msg.password) });
        ws.roomId = roomId;
        ws.role = "sender";

        send(ws, { type: "room-created", roomId });
        console.log(`Room created: ${roomId}${msg.password ? " (password protected)" : ""}`);
        break;
      }

      case "join-room": {
        const room = rooms.get(msg.roomId);

        if (!room) {
          send(ws, { type: "error", message: "Room not found" });
          return;
        }
        if (room.receiver) {
          send(ws, { type: "error", message: "Room is full" });
          return;
        }
        if (room.passwordHash && hashPassword(msg.password) !== room.passwordHash) {
          send(ws, { type: "error", message: "Wrong password" });
          return;
        }

        room.receiver = ws;
        ws.roomId = msg.roomId;
        ws.role = "receiver";

        send(ws, { type: "room-joined", roomId: msg.roomId });
        send(room.sender, { type: "peer-joined" });
        console.log(`Peer joined room: ${msg.roomId}`);
        break;
      }

      case "sdp-offer": {
        const room = rooms.get(ws.roomId);
        if (room) send(room.receiver, { type: "sdp-offer", sdp: msg.sdp });
        break;
      }

      case "sdp-answer": {
        const room = rooms.get(ws.roomId);
        if (room) send(room.sender, { type: "sdp-answer", sdp: msg.sdp });
        break;
      }

      case "ice-candidate": {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const peer = ws.role === "sender" ? room.receiver : room.sender;
        send(peer, { type: "ice-candidate", candidate: msg.candidate });
        break;
      }
    }
  });

  ws.on("close", () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;

    if (ws.role === "sender") {
      send(room.receiver, { type: "peer-disconnected" });
      rooms.delete(ws.roomId);
      console.log(`Room closed: ${ws.roomId}`);
    } else if (ws.role === "receiver") {
      send(room.sender, { type: "peer-disconnected" });
      room.receiver = null;
    }
  });
});

// Heartbeat: ping every 30s, terminate unresponsive clients
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(heartbeat));

console.log(`Signaling server running on ws://localhost:${PORT}`);
