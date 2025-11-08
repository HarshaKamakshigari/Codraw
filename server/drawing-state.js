// In-memory drawing history for a single room.
// Keeps a linear log of operations and a redo stack.
// This deliberately avoids persistence to keep the demo simple.
export class DrawingState {
    constructor() {
        this.operations = [];
        this.redoStack = [];
        this.version = 0;
    }

    /**
     * Append a validated operation to the history and bump the version.
     * Clears the redo stack on any new operation.
     */
    addOperation(op) {
        validateOperation(op);
        this.operations.push(op);
        this.redoStack.length = 0; // clear redo on new op
        this.version += 1;
    }

    /**
     * Undo the last operation if any. Returns true on success.
     * We store the undone op on the redo stack.
     */
    undo() {
        if (this.operations.length === 0) return false;
        const op = this.operations.pop();
        this.redoStack.push(op);
        this.version += 1;
        return true;
    }

    /**
     * Redo the last undone operation if any. Returns true on success.
     */
    redo() {
        if (this.redoStack.length === 0) return false;
        const op = this.redoStack.pop();
        this.operations.push(op);
        this.version += 1;
        return true;
    }

    /**
     * Get a shallow snapshot suitable for broadcasting to clients.
     * The operations array is reused on the client for replay.
     */
    getSnapshot() {
        return {
            version: this.version,
            operations: this.operations,
        };
    }

    /**
     * Remove all operations authored by a specific userId.
     * Returns the number of removed operations.
     */
    removeByUser(userId) {
        if (!userId) return false;
        const before = this.operations.length;
        const remaining = [];
        for (const op of this.operations) {
            if (op.userId !== userId) remaining.push(op);
        }
        const removed = before - remaining.length;
        this.operations = remaining;
        // Clear redo stack since history changed
        this.redoStack.length = 0;
        if (removed > 0) {
            this.version += 1;
            // eslint-disable-next-line no-console
            console.log('[server] removed user operations', { userId, removed, version: this.version });
            return removed;
        }
        return 0;
    }

    /**
     * Clear all operations in the room (global reset).
     * Returns the number of operations removed.
     */
    clearAll() {
        const removed = this.operations.length;
        this.operations = [];
        this.redoStack = [];
        if (removed > 0) {
            this.version += 1;
            // eslint-disable-next-line no-console
            console.log('[server] clearAll', { removed, version: this.version });
        }
        return removed;
    }
}

/**
 * Runtime validation for accepted operations.
 * We keep rules minimal but explicit so bad payloads fail fast.
 */
function validateOperation(op) {
    if (!op) throw new Error("Empty operation");
    if (op.type === "stroke") {
        if (!Array.isArray(op.points) || op.points.length < 2) {
            throw new Error("Stroke must contain at least two points");
        }
        if (typeof op.size !== "number" || op.size <= 0) {
            throw new Error("Invalid stroke size");
        }
        if (typeof op.color !== "string") throw new Error("Invalid color");
        if (op.composite !== "source-over" && op.composite !== "destination-out") {
            throw new Error("Invalid composite mode");
        }
        return;
    }
    if (op.type === "shape") {
        const allowed = new Set(["circle", "square", "triangle"]);
        if (!allowed.has(op.shape)) throw new Error("Invalid shape type");
        if (typeof op.x !== "number" || typeof op.y !== "number") {
            throw new Error("Invalid shape position");
        }
        // Allow either size (legacy) or width/height (preferred)
        const hasLegacySize = typeof op.size === "number" && op.size > 0;
        const hasWH = typeof op.width === "number" && op.width > 0 && typeof op.height === "number" && op.height > 0;
        if (!hasLegacySize && !hasWH) throw new Error("Invalid shape dimensions");
        if (typeof op.color !== "string") throw new Error("Invalid color");
        return;
    }
    if (op.type === "shape:update") {
        if (typeof op.targetId !== "string" || op.targetId.length === 0) throw new Error("Missing targetId");
        // Allow partial updates but require at least one dimension or position change
        const hasPos = typeof op.x === "number" && typeof op.y === "number";
        const hasWH = typeof op.width === "number" && op.width > 0 && typeof op.height === "number" && op.height > 0;
        const hasColor = typeof op.color === "string";
        if (!hasPos && !hasWH && !hasColor) throw new Error("Empty shape update");
        return;
    }
    throw new Error("Unsupported operation type");
}


