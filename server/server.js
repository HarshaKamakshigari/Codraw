// Express + Socket.io server for the collaborative canvas.
// Responsibilities:
// - Serve the static client from /client
// - Manage socket connections and room membership
// - Validate and fan out drawing operations
// - Maintain presence and ephemeral events (cursor, progress, reactions)

import express from "express";
import http from "http";
import { Server } from "socket.io";
import { nanoid } from "nanoid";
import { RoomManager } from "./rooms.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
    cors: { origin: "*" },
});

// Serve static assets (works from repo root or when deploying only /server)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLIENT_DIR = path.resolve(__dirname, "../client");
if (fs.existsSync(CLIENT_DIR)) {
    app.use(express.static(CLIENT_DIR));
}

// Health check
app.get("/health", (_req, res) => {
    res.json({ ok: true });
});

const roomManager = new RoomManager();

// Basic pleasant color palette
const USER_COLORS = [
    "#ff6b6b",
    "#f06595",
    "#845ef7",
    "#5c7cfa",
    "#339af0",
    "#22b8cf",
    "#12b886",
    "#51cf66",
    "#ffd43b",
    "#ffa94d",
];

function assignColor(index) {
    return USER_COLORS[index % USER_COLORS.length];
}

io.on("connection", (socket) => {
    // Pick a room; default to "lobby". Clients can pass ?roomId=foo.
    const roomId = (socket.handshake.query.roomId || "lobby").toString();
    roomManager.ensureRoom(roomId);

    // Create a lightweight user identity for presence and attribution.
    const userId = nanoid(8);
    const displayName = `Guest-${userId.slice(0, 4)}`;
    const color = assignColor(Math.abs(hashString(userId)));

    const user = { userId, displayName, color };
    roomManager.join(socket, roomId, user);
    // eslint-disable-next-line no-console
    console.log('[server] user connected', { roomId, userId, displayName });

    // Send initial snapshot (history) and presence list to the new client.
    const snapshot = roomManager.getState(roomId).getSnapshot();
    const users = roomManager.getUsers(roomId);
    socket.emit("init", { user, snapshot, users });
    // Tell everyone else that a user joined.
    socket.to(roomId).emit("presence:join", { user });

    // Cursor movement (ephemeral). Broadcast to others in the room.
    socket.on("cursor:move", (payload) => {
        socket.to(roomId).emit("cursor:move", { userId, ...payload });
    });

    // Progress events are ephemeral and not persisted.
    // Used by clients to render a smooth in-progress stroke.
    socket.on("draw:progress", (payload) => {
        socket.to(roomId).emit("draw:progress", { userId, ...payload });
    });

    // Shape transform progress (ephemeral)
    socket.on("shape:progress", (payload) => {
        // payload: { id, x?, y?, width?, height? }
        socket.to(roomId).emit("shape:progress", { userId, ...payload });
    });

    // (text progress removed)

    // Commit events become operations in the shared log.
    socket.on("draw:commit", (op) => {
        try {
            const opWithMeta = {
                ...op,
                id: nanoid(10),
                userId,
                timestamp: Date.now(),
            };
            roomManager.getState(roomId).addOperation(opWithMeta);
            // eslint-disable-next-line no-console
            console.log('[server] draw:commit', { roomId, userId, opType: op?.type });
            io.in(roomId).emit("draw:commit", opWithMeta);
        } catch (err) {
            socket.emit("error:message", { message: err?.message || "Invalid operation" });
        }
    });

    // Global undo simply rewinds the room's operation log by one.
    socket.on("op:undo", () => {
        const state = roomManager.getState(roomId);
        if (state.undo()) {
            io.in(roomId).emit("state:full", state.getSnapshot());
        }
    });

    // Global redo reapplies the last undone operation.
    socket.on("op:redo", () => {
        const state = roomManager.getState(roomId);
        if (state.redo()) {
            io.in(roomId).emit("state:full", state.getSnapshot());
        }
    });

    // Clear only the caller's authored operations.
    socket.on("op:clearUser", (ack) => {
        // eslint-disable-next-line no-console
        console.log('[server] op:clearUser received', { roomId, userId });
        const state = roomManager.getState(roomId);
        const removed = state.removeByUser(userId);
        if (removed > 0) {
            // eslint-disable-next-line no-console
            console.log('[server] broadcasting state after clearUser', { version: state.version, removed });
            io.in(roomId).emit("state:full", state.getSnapshot());
            if (typeof ack === 'function') ack({ ok: true, removed, version: state.version });
        } else {
            if (typeof ack === 'function') ack({ ok: false, removed: 0, version: state.version });
        }
    });

    // Clear all operations in the room (global reset).
    socket.on("op:clearAll", (ack) => {
        // eslint-disable-next-line no-console
        console.log('[server] op:clearAll received', { roomId, userId });
        const state = roomManager.getState(roomId);
        const removed = state.clearAll();
        if (removed > 0) {
            io.in(roomId).emit("state:full", state.getSnapshot());
            if (typeof ack === 'function') ack({ ok: true, removed, version: state.version });
        } else {
            if (typeof ack === 'function') ack({ ok: false, removed: 0, version: state.version });
        }
    });

    // Presence teardown on disconnect.
    socket.on("disconnect", () => {
        roomManager.leave(socket, roomId);
        socket.to(roomId).emit("presence:leave", { userId });
    });

    // Reactions (ephemeral, broadcast to all in the room).
    socket.on("reaction", ({ emoji }) => {
        if (typeof emoji !== "string" || !emoji) return;
        io.in(roomId).emit("reaction", { id: nanoid(8), userId, emoji, ts: Date.now() });
    });
});

httpServer.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Server running on http://localhost:${PORT}`);
});

function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = (h << 5) - h + str.charCodeAt(i);
        h |= 0;
    }
    return Math.abs(h);
}


