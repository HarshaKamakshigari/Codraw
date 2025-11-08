// Lightweight Socket.io client wrapper used by the app.
// Exposes a narrow API for sending actions and registering handlers.
export class RealtimeClient {
    /**
     * @param {Object} deps
     * @param {(payload:any)=>void} [deps.onInit]
     * @param {(payload:any)=>void} [deps.onProgress]
     * @param {(payload:any)=>void} [deps.onCommit]
     * @param {(payload:any)=>void} [deps.onState]
     * @param {(payload:any)=>void} [deps.onPresenceJoin]
     * @param {(payload:any)=>void} [deps.onPresenceLeave]
     * @param {(payload:any)=>void} [deps.onCursor]
     * @param {(payload:any)=>void} [deps.onReaction]
     * @param {(payload:any)=>void} [deps.onShapeProgress]
     */
    constructor({ onInit, onProgress, onCommit, onState, onPresenceJoin, onPresenceLeave, onCursor, onReaction, onShapeProgress }) {
        this.handlers = { onInit, onProgress, onCommit, onState, onPresenceJoin, onPresenceLeave, onCursor, onReaction, onShapeProgress };
        const globalIo = (typeof window !== 'undefined') ? window.io : undefined;
        this.socket = globalIo
            ? globalIo("https://codraw-production.up.railway.app", { path: "/socket.io" })
            : createNoopSocket();
        this.bind();
    }

    bind() {
        // Baseline event hooks. The server sends structured payloads we pass through.
        this.socket.on("connect", () => {
            // noop; init will arrive separately
        });
        this.socket.on("init", (payload) => this.handlers.onInit?.(payload));
        this.socket.on("draw:progress", (payload) => this.handlers.onProgress?.(payload));
        this.socket.on("draw:commit", (payload) => this.handlers.onCommit?.(payload));
        this.socket.on("state:full", (payload) => this.handlers.onState?.(payload));
        this.socket.on("presence:join", (payload) => this.handlers.onPresenceJoin?.(payload));
        this.socket.on("presence:leave", (payload) => this.handlers.onPresenceLeave?.(payload));
        this.socket.on("cursor:move", (payload) => this.handlers.onCursor?.(payload));
        this.socket.on("reaction", (payload) => this.handlers.onReaction?.(payload));
        this.socket.on("shape:progress", (payload) => this.handlers.onShapeProgress?.(payload));
    }

    /** Send a streaming progress fragment for in-flight drawing. */
    sendProgress(progress) { this.socket?.emit?.("draw:progress", progress); }
    /** Send a streaming transform fragment for in-flight shape changes. */
    sendShapeProgress(progress) { this.socket?.emit?.("shape:progress", progress); }
    /** Send a final operation that becomes part of history. */
    sendCommit(op) { this.socket?.emit?.("draw:commit", op); }
    /** Request a global undo. */
    sendUndo() { this.socket?.emit?.("op:undo"); }
    /** Request a global redo. */
    sendRedo() { this.socket?.emit?.("op:redo"); }
    /** Broadcast current cursor position (world coordinates). */
    sendCursor(pos) { this.socket?.emit?.("cursor:move", pos); }
    /** Broadcast a lightweight reaction to the room. */
    sendReaction(emoji) { this.socket?.emit?.("reaction", { emoji }); }
    /** Ask server to delete only my authored operations. */
    sendClearMine(cb) {
        console.log('[client] sendClearMine emit');
        try {
            this.socket?.emit?.("op:clearUser", (res) => {
                console.log('[client] clearMine ack', res);
                cb && cb(res);
            });
        } catch (e) {
            console.error('[client] clearMine error', e);
            cb && cb({ ok: false, error: String(e) });
        }
    }
    /** Ask server to clear the entire board (all operations). */
    sendClearAll(cb) {
        console.log('[client] sendClearAll emit');
        try {
            this.socket?.emit?.("op:clearAll", (res) => {
                console.log('[client] clearAll ack', res);
                cb && cb(res);
            });
        } catch (e) {
            console.error('[client] clearAll error', e);
            cb && cb({ ok: false, error: String(e) });
        }
    }
}

function createNoopSocket() {
    const noop = () => { };
    return {
        emit: noop,
        on: noop,
        timeout: () => ({ emit: noop }),
    };
}


