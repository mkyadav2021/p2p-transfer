const WS_URL = location.hostname === "localhost"
  ? "ws://localhost:8080"
  : "https://p2p-transfer-zh77.onrender.com"; // replace after Render deploy
const PC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const CHUNK_SIZE = 64 * 1024;        // 64 KB per chunk
const BUFFER_THRESHOLD = 2 * 1024 * 1024; // pause sending when DC buffer exceeds 2 MB

// ─── State ────────────────────────────────────────────────────────────────
let ws = null;
let pc = null;
let dataChannel = null;
let selectedFile = null;

// Receiver reassembly
let metadata = null;
let receivedChunks = [];
let receivedBytes = 0;

// Progress tracking
let transferStartTime = null;

// ICE candidates queued before remote description is set
let pendingCandidates = [];
let remoteDescSet = false;

// ─── DOM refs ─────────────────────────────────────────────────────────────
const dropZone        = document.getElementById("drop-zone");
const fileInput       = document.getElementById("file-input");
const receiverView    = document.getElementById("receiver-view");
const roomIdDisplay   = document.getElementById("room-id-display");
const fileInfo        = document.getElementById("file-info");
const fileNameEl      = document.getElementById("file-name");
const fileSizeEl      = document.getElementById("file-size");
const linkSection     = document.getElementById("link-section");
const shareLinkEl     = document.getElementById("share-link");
const copyBtn         = document.getElementById("copy-btn");
const qrCodeEl        = document.getElementById("qr-code");
const transferSection = document.getElementById("transfer-section");
const progressBar     = document.getElementById("progress-bar");
const progressPct     = document.getElementById("progress-pct");
const transferSpeedEl = document.getElementById("transfer-speed");
const downloadSection = document.getElementById("download-section");
const downloadBtn     = document.getElementById("download-btn");
const statusEl        = document.getElementById("status");

// ─── Utilities ────────────────────────────────────────────────────────────
function formatSize(bytes) {
  if (bytes < 1024)        return bytes + " B";
  if (bytes < 1024 ** 2)   return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 ** 3)   return (bytes / 1024 ** 2).toFixed(1) + " MB";
  return (bytes / 1024 ** 3).toFixed(2) + " GB";
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? "error" : "";
}

function updateProgress(fraction) {
  const pct = Math.min(100, Math.round(fraction * 100));
  progressBar.style.width = pct + "%";
  progressPct.textContent = pct + "%";
}

function updateSpeed(bytesDone) {
  const elapsed = (Date.now() - transferStartTime) / 1000;
  if (elapsed < 0.5) return;
  transferSpeedEl.textContent = formatSize(bytesDone / elapsed) + "/s";
}

// ─── WebRTC shared ────────────────────────────────────────────────────────
function createPeerConnection() {
  pc = new RTCPeerConnection(PC_CONFIG);

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      ws.send(JSON.stringify({ type: "ice-candidate", candidate }));
    }
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    if (s === "failed") {
      setStatus(
        "WebRTC connection failed — STUN could not punch through. Try a different network.",
        true
      );
    }
    if (s === "disconnected") {
      setStatus("Connection lost — the other peer may have closed the tab.", true);
    }
  };
}

// Queue candidates until setRemoteDescription has been called
async function addIceCandidate(candidate) {
  if (remoteDescSet && pc) {
    await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
  } else {
    pendingCandidates.push(candidate);
  }
}

async function flushPendingCandidates() {
  remoteDescSet = true;
  for (const c of pendingCandidates) {
    await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
  }
  pendingCandidates = [];
}

// ─── Sender ───────────────────────────────────────────────────────────────
function initSender() {
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", (e) => {
    if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove("dragover");
  });
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    const file = e.dataTransfer.files[0];
    if (file) onFileSelected(file);
  });
  dropZone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (file) onFileSelected(file);
  });
  copyBtn.addEventListener("click", () => {
    shareLinkEl.select();
    navigator.clipboard.writeText(shareLinkEl.value).then(() => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy"), 2000);
    });
  });
}

function onFileSelected(file) {
  selectedFile = file;
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = formatSize(file.size);
  fileInfo.hidden = false;
  setStatus("Connecting to server...");
  connectSender();
}

function connectSender() {
  ws = new WebSocket(WS_URL);
  ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "create-room" })));
  ws.addEventListener("message", (e) => handleSenderMessage(JSON.parse(e.data)));
  ws.addEventListener("close", () => setStatus("Disconnected from server.", true));
  ws.addEventListener("error", () => setStatus("Connection error — is the server running?", true));
}

function handleSenderMessage(msg) {
  if (msg.type === "room-created") {
    const url = `${location.origin}${location.pathname}#${msg.roomId}`;
    shareLinkEl.value = url;
    linkSection.hidden = false;
    generateQR(url);
    setStatus(`Room ${msg.roomId} created — waiting for receiver...`);
  }

  if (msg.type === "peer-joined") {
    setStatus("Peer joined — establishing WebRTC connection...");
    startOffer();
  }

  if (msg.type === "sdp-answer") {
    pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)).then(flushPendingCandidates);
  }

  if (msg.type === "ice-candidate") {
    addIceCandidate(msg.candidate);
  }

  if (msg.type === "peer-disconnected") {
    setStatus("Receiver disconnected.", true);
  }
}

async function startOffer() {
  createPeerConnection();

  dataChannel = pc.createDataChannel("file-transfer");
  setupSenderChannel(dataChannel);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: "sdp-offer", sdp: pc.localDescription }));
  setStatus("Sent offer — waiting for answer...");
}

function setupSenderChannel(channel) {
  channel.onopen = () => {
    transferSection.hidden = false;
    transferStartTime = Date.now();
    setStatus(`Sending ${selectedFile.name}...`);
    sendMetadata();
    sendFile();
  };
  channel.onerror = () => setStatus("Data channel error.", true);
  channel.onclose = () => {
    if (progressPct.textContent !== "100%") {
      setStatus("Transfer cancelled — receiver closed the connection.", true);
    }
  };
}

function sendMetadata() {
  dataChannel.send(JSON.stringify({
    type: "metadata",
    name: selectedFile.name,
    size: selectedFile.size,
    mimeType: selectedFile.type || "application/octet-stream",
  }));
}

async function sendFile() {
  let offset = 0;

  while (offset < selectedFile.size) {
    // Backpressure: pause if the send buffer is getting full
    if (dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
      dataChannel.bufferedAmountLowThreshold = BUFFER_THRESHOLD / 2;
      await new Promise((resolve) =>
        dataChannel.addEventListener("bufferedamountlow", resolve, { once: true })
      );
    }

    const slice = selectedFile.slice(offset, offset + CHUNK_SIZE);
    const buffer = await slice.arrayBuffer();
    dataChannel.send(buffer);
    offset += buffer.byteLength;
    updateProgress(offset / selectedFile.size);
    updateSpeed(offset);
  }

  dataChannel.send(JSON.stringify({ type: "done" }));
  setStatus("Transfer complete!");
}

function generateQR(url) {
  if (typeof window.QRCode === "undefined") return;
  qrCodeEl.innerHTML = "";
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  new window.QRCode(qrCodeEl, {
    text: url,
    width: 128,
    height: 128,
    colorDark: dark ? "#e2e8f0" : "#1a1a2e",
    colorLight: dark ? "#1a1d27" : "#ffffff",
  });
}

// ─── Receiver ─────────────────────────────────────────────────────────────
function initReceiver(roomId) {
  dropZone.hidden = true;
  receiverView.hidden = false;
  roomIdDisplay.textContent = roomId;
  setStatus("Connecting to server...");
  connectReceiver(roomId);
}

function connectReceiver(roomId) {
  ws = new WebSocket(WS_URL);
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "join-room", roomId }));
    setStatus("Joining room...");
  });
  ws.addEventListener("message", (e) => handleReceiverMessage(JSON.parse(e.data)));
  ws.addEventListener("close", () => setStatus("Disconnected from server.", true));
  ws.addEventListener("error", () => setStatus("Connection error — is the server running?", true));
}

function handleReceiverMessage(msg) {
  if (msg.type === "room-joined") {
    setStatus("Joined — waiting for sender...");
  }

  if (msg.type === "sdp-offer") {
    setStatus("Received offer — connecting...");
    handleOffer(msg.sdp);
  }

  if (msg.type === "ice-candidate") {
    addIceCandidate(msg.candidate);
  }

  if (msg.type === "peer-disconnected") {
    setStatus("Sender disconnected.", true);
  }

  if (msg.type === "error") {
    setStatus(
      msg.message === "Room not found"
        ? "This link has expired or the room does not exist."
        : msg.message,
      true
    );
  }
}

async function handleOffer(sdp) {
  createPeerConnection();
  pc.ondatachannel = (e) => setupReceiverChannel(e.channel);

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  await flushPendingCandidates();

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  ws.send(JSON.stringify({ type: "sdp-answer", sdp: pc.localDescription }));
}

function setupReceiverChannel(channel) {
  // Must be set before any binary data arrives
  channel.binaryType = "arraybuffer";

  channel.onmessage = (e) => {
    if (typeof e.data === "string") {
      const msg = JSON.parse(e.data);

      if (msg.type === "metadata") {
        metadata = msg;
        fileNameEl.textContent = msg.name;
        fileSizeEl.textContent = formatSize(msg.size);
        fileInfo.hidden = false;
        transferSection.hidden = false;
        transferStartTime = Date.now();
        setStatus(`Receiving ${msg.name}...`);
      }

      if (msg.type === "done") {
        finishDownload();
      }
    } else {
      // Binary chunk
      receivedChunks.push(e.data);
      receivedBytes += e.data.byteLength;
      updateProgress(receivedBytes / metadata.size);
      updateSpeed(receivedBytes);
    }
  };

  channel.onerror = () => setStatus("Data channel error.", true);
  channel.onclose = () => {
    if (receivedBytes < (metadata?.size ?? 1)) {
      setStatus("Transfer cancelled — sender closed the connection.", true);
    }
  };
}

function finishDownload() {
  const blob = new Blob(receivedChunks, { type: metadata.mimeType });
  const url = URL.createObjectURL(blob);
  downloadBtn.href = url;
  downloadBtn.download = metadata.name;
  downloadSection.hidden = false;
  setStatus("Download ready!");
  // Release blob URL after the user has had time to save
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ─── Boot ─────────────────────────────────────────────────────────────────
const roomId = window.location.hash.slice(1); // strip leading #
if (roomId) {
  initReceiver(roomId);
} else {
  initSender();
}
