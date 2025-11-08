// RoomManager tracks per-room drawing state and connected users.
// For this MVP we keep everything in memory and keyed by roomId.
import { DrawingState } from "./drawing-state.js";

export class RoomManager {
    constructor() {
        this.rooms = new Map(); // roomId -> { state: DrawingState, users: Map<socketId, user> }
    }

    /**
     * Ensure a room record exists for a given roomId.
     * Creates a new DrawingState and empty users map on first access.
     */
    ensureRoom(roomId) {
        if (!this.rooms.has(roomId)) {
            this.rooms.set(roomId, { state: new DrawingState(), users: new Map() });
        }
    }

    /**
     * Add a socket to a room and register its user payload.
     */
    join(socket, roomId, user) {
        this.ensureRoom(roomId);
        const room = this.rooms.get(roomId);
        room.users.set(socket.id, user);
        socket.join(roomId);
    }

    /**
     * Remove a socket from a room and drop presence.
     */
    leave(socket, roomId) {
        const room = this.rooms.get(roomId);
        if (!room) return;
        room.users.delete(socket.id);
        socket.leave(roomId);
    }

    /**
     * Get the DrawingState for a room (creating the room if needed).
     */
    getState(roomId) {
        this.ensureRoom(roomId);
        return this.rooms.get(roomId).state;
    }

    /**
     * Get a simple array of currently present users for a room.
     */
    getUsers(roomId) {
        this.ensureRoom(roomId);
        return Array.from(this.rooms.get(roomId).users.values());
    }
}


