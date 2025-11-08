
export class CanvasManager {
    /**
     * @param {Object} deps
     * @param {HTMLElement} deps.canvasHost container element holding the visible canvas
     * @param {(progress:any)=>void} deps.onProgress callback for in-progress stroke fragments
     * @param {(op:any)=>void} deps.onCommit callback for finalized operations
     * @param {(t:{scale:number, pan:{x:number,y:number}})=>void} deps.onTransform transform observer
     */
    constructor({ canvasHost, onProgress, onCommit, onTransform, onShapeProgress }) {
        this.canvasHost = canvasHost;
        this.onProgress = onProgress;
        this.onCommit = onCommit;
        this.onTransform = onTransform;
        this.onShapeProgress = onShapeProgress;

        this.mainCanvas = canvasHost.querySelector("#canvas");
        this.overlayCanvas = document.createElement("canvas");
        this.overlayCanvas.style.position = "absolute";
        this.overlayCanvas.style.inset = "0";
        this.overlayCanvas.style.width = "100%";
        this.overlayCanvas.style.height = "100%";
        canvasHost.appendChild(this.overlayCanvas);

        this.ctx = this.mainCanvas.getContext("2d");
        this.overlayCtx = this.overlayCanvas.getContext("2d");

        this.devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
        this.scale = 1;
        this.pan = { x: 0, y: 0 }; // CSS pixels
        this.operations = [];
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.canvasHost);
        this.resize();

        // Local drawing state
        this.active = false;
        this.tool = "brush"; // brush | eraser
        this.color = "#1f2937";
        this.size = 8;
        this.localPoints = [];
        this.lastProgressAt = 0;

        // Remote ephemeral progress strokes by userId
        this.remoteProgress = new Map(); // userId -> { points, color, size, composite }

        // Shape tool state
        this.shapeType = "circle"; // circle | square | triangle
        this.shapes = new Map(); // id -> { id, shape, x, y, width, height, color }
        this.selectedShapeId = null;
        this.transformDraft = null; // { id, kind: 'move'|'resize', start, orig }
        this.draftCreate = null; // { shape, x, y, width, height, color }

        // Animation loop for overlay redraw
        const loop = () => {
            this.redrawOverlayLayer();
            this.raf = requestAnimationFrame(loop);
        };
        this.raf = requestAnimationFrame(loop);

        // Pointer events
        this.bindPointerEvents();
        // Initialize cursor state
        this.updateCursorClasses();
        // Apply initial transform after all state is ready
        this.applyTransform();
    }

    destroy() {
        cancelAnimationFrame(this.raf);
        this.resizeObserver.disconnect();
    }

    // Keep canvases in sync with container size and DPR.
    resize() {
        const rect = this.canvasHost.getBoundingClientRect();
        const cssW = rect.width;
        const cssH = rect.height;
        const w = Math.max(1, Math.round(cssW * this.devicePixelRatio));
        const h = Math.max(1, Math.round(cssH * this.devicePixelRatio));
        for (const c of [this.mainCanvas, this.overlayCanvas]) {
            c.width = w;
            c.height = h;
            // Ensure the CSS size exactly matches the DOM rect to avoid subpixel drift
            c.style.width = `${cssW}px`;
            c.style.height = `${cssH}px`;
        }
        this.ctx.lineCap = "round";
        this.ctx.lineJoin = "round";
        this.overlayCtx.lineCap = "round";
        this.overlayCtx.lineJoin = "round";
        // Redraw main is handled by state replay externally on resize if needed
    }

    /** Tool and style setters. */
    setTool(tool) { this.tool = tool; this.updateCursorClasses(); }
    setColor(color) { this.color = color; }
    setSize(size) { this.size = size; }
    setShapeType(shape) { this.shapeType = shape || "circle"; }
    /** Scale bounds are clamped for stability. */
    setScale(scale) {
        this.scale = Math.max(0.25, Math.min(4, scale));
        this.applyTransform();
    }
    getScale() { return this.scale; }
    getPan() { return { x: this.pan.x, y: this.pan.y }; }
    getDpr() { return this.devicePixelRatio; }

    setPan(x, y) {
        this.pan.x = x; this.pan.y = y; this.applyTransform();
    }

    // Apply transform to both contexts and trigger a redraw.
    applyTransform() {
        const d = this.devicePixelRatio;
        const sx = this.scale * d;
        const sy = this.scale * d;
        const tx = this.pan.x * d;
        const ty = this.pan.y * d;
        this.ctx.setTransform(sx, 0, 0, sy, tx, ty);
        this.overlayCtx.setTransform(sx, 0, 0, sy, tx, ty);
        this.onTransform?.({ scale: this.scale, pan: { ...this.pan } });
        // Redraw committed content under new transform
        this.redrawAll();
    }

    /** Clear both layers locally (does not affect remote state). */
    clearLocal() {
        this.ctx.clearRect(0, 0, this.mainCanvas.width, this.mainCanvas.height);
        this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    }

    // Bind all pointer and wheel interactions.
    bindPointerEvents() {
        const el = this.overlayCanvas;
        el.style.touchAction = "none";
        el.addEventListener("pointerdown", (e) => this.onPointerDown(e));
        el.addEventListener("pointermove", (e) => this.onPointerMove(e));
        window.addEventListener("pointerup", (e) => this.onPointerUp(e));
        el.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
        el.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
        window.addEventListener("keydown", (e) => { if (e.code === "Space") { this.spacePressed = true; this.updateCursorClasses(); } });
        window.addEventListener("keyup", (e) => { if (e.code === "Space") { this.spacePressed = false; this.panning = false; this.panStart = null; this.updateCursorClasses(); } });
        // Wheel: pan normally, zoom with Ctrl/Cmd
        el.addEventListener("wheel", (e) => {
            e.preventDefault();
            const rect = this.overlayCanvas.getBoundingClientRect();
            if (e.ctrlKey || e.metaKey) {
                const before = this.scale;
                const factor = Math.exp(-e.deltaY * 0.001);
                const next = Math.max(0.25, Math.min(4, before * factor));
                // Zoom to cursor position: keep world point under cursor fixed
                const cx = e.clientX - rect.left;
                const cy = e.clientY - rect.top;
                const worldX = (cx - this.pan.x) / before;
                const worldY = (cy - this.pan.y) / before;
                this.setScale(next);
                this.setPan(cx - worldX * next, cy - worldY * next);
            } else {
                this.setPan(this.pan.x - e.deltaX, this.pan.y - e.deltaY);
            }
        }, { passive: false });
    }

    // Convert a pointer event to a world-space point (CSS pixels, unscaled).
    getPoint(e) {
        const rect = this.overlayCanvas.getBoundingClientRect();
        // World coordinates in CSS pixels (device-independent), normalized by pan/zoom only
        const x = (e.clientX - rect.left - this.pan.x) / this.scale;
        const y = (e.clientY - rect.top - this.pan.y) / this.scale;
        const t = performance.now();
        return { x, y, t };
    }

    onPointerDown(e) {
        const isPan = e.button === 1 || this.tool === "pan" || this.spacePressed || (e.button === 0 && e.altKey);
        if (isPan) {
            const p = this.getPoint(e);
            // If hand tool is active and user presses on a shape, move that instead of panning
            if (this.tool === "pan") {
                const hit = this.hitTestShape(p.x, p.y);
                if (hit) {
                    this.selectedShapeId = hit;
                    const shape = this.shapes.get(hit);
                    this.transformDraft = {
                        id: hit,
                        kind: "move",
                        start: p,
                        orig: { x: shape.x, y: shape.y },
                    };
                    this.active = true;
                    return;
                }
            }
            // Otherwise, pan the canvas
            this.panning = true;
            this.panStart = { x: e.clientX, y: e.clientY, ox: this.pan.x, oy: this.pan.y };
            this.updateCursorClasses(true);
            return;
        }
        if (e.button !== 0 && e.pointerType !== "touch") return;
        const p = this.getPoint(e);
        if (this.tool === "shape") {
            // Start drag-to-create
            this.draftCreate = { shape: this.shapeType, x: p.x, y: p.y, width: 0, height: 0, color: this.color };
            this.active = true;
            return;
        }
        // 'select' tool not used; selection/resize handled via Hand or shape creation.
        // Default drawing (brush/eraser)
        this.overlayCanvas.setPointerCapture?.(e.pointerId);
        this.active = true;
        this.localPoints = [p];
    }

    onPointerMove(e) {
        if (this.panning && this.panStart) {
            const dx = e.clientX - this.panStart.x;
            const dy = e.clientY - this.panStart.y;
            this.setPan(this.panStart.ox + dx, this.panStart.oy + dy);
            return;
        }
        if (!this.active) return;
        const p = this.getPoint(e);

        // Creating a shape
        if (this.draftCreate) {
            this.draftCreate.width = p.x - this.draftCreate.x;
            this.draftCreate.height = p.y - this.draftCreate.y;
            return;
        }

        // Transforming a selected element
        if (this.transformDraft) {
            const draft = this.transformDraft;
            if (draft.kind === "move") {
                const dx = p.x - draft.start.x;
                const dy = p.y - draft.start.y;
                const s = this.shapes.get(draft.id);
                if (s) {
                    s.x = draft.orig.x + dx;
                    s.y = draft.orig.y + dy;
                    // Throttled ephemeral progress
                    const now = performance.now();
                    if (!this._lastShapeProgressAt || (now - this._lastShapeProgressAt) > 16) {
                        this._lastShapeProgressAt = now;
                        this.onShapeProgress?.({ id: draft.id, x: s.x, y: s.y });
                    }
                }
            }
            return;
        }

        // Brush/eraser
        const prev = this.localPoints[this.localPoints.length - 1];
        if (!prev || distance(prev, p) >= 0.5 * this.devicePixelRatio) {
            this.localPoints.push(p);
        }
        // Immediate live erase: draw last segment directly on main canvas
        if (this.tool === "eraser" && this.localPoints.length >= 2) {
            const pts = this.localPoints.slice(-3);
            this.drawStroke(this.ctx, {
                points: pts,
                color: this.color,
                size: this.size,
                composite: "destination-out",
            });
        }
        // Throttle progress events (60 Hz cap)
        const now = performance.now();
        if (now - this.lastProgressAt > 16) {
            this.lastProgressAt = now;
            this.onProgress?.({
                points: this.localPoints.slice(-3), // only last few for streaming
                color: this.color,
                size: this.size,
                composite: this.tool === "eraser" ? "destination-out" : "source-over",
            });
        }
    }

    onPointerUp(_e) {
        if (this.panning) { this.panning = false; this.panStart = null; this.updateCursorClasses(); return; }

        // Finish creating a shape
        if (this.draftCreate) {
            const d = this.normalizeRect(this.draftCreate);
            // Click without drag: fallback to slider size centered at point
            if (Math.abs(d.width) < 2 && Math.abs(d.height) < 2) {
                const cx = d.x, cy = d.y;
                const s = Math.max(1, this.size);
                const op = { type: "shape", shape: d.shape, x: cx - s / 2, y: cy - s / 2, width: s, height: s, color: d.color };
                this.applyCommit(op);
                this.onCommit?.(op);
            } else {
                const op = { type: "shape", shape: d.shape, x: d.x, y: d.y, width: d.width, height: d.height, color: d.color };
                this.applyCommit(op);
                this.onCommit?.(op);
            }
            this.draftCreate = null;
            this.active = false;
            return;
        }

        // Finish transforming element
        if (this.transformDraft) {
            const id = this.transformDraft.id;
            const s = this.shapes.get(id);
            if (s) {
                const op = { type: "shape:update", targetId: id, x: s.x, y: s.y, width: s.width, height: s.height, color: s.color };
                this.onCommit?.(op);
            }
            this.transformDraft = null;
            this.active = false;
            return;
        }

        if (!this.active) return;
        this.active = false;
        const points = simplifyPoints(this.localPoints);
        this.drawStroke(this.ctx, {
            points,
            color: this.color,
            size: this.size,
            composite: this.tool === "eraser" ? "destination-out" : "source-over",
        });
        this.localPoints = [];
        this.onCommit?.({
            type: "stroke",
            points,
            color: this.color,
            size: this.size,
            composite: this.tool === "eraser" ? "destination-out" : "source-over",
        });
    }

    // Cursor class toggles for different tools and states.
    updateCursorClasses(forceGrabbing) {
        const host = this.canvasHost;
        host.classList.remove("cursor-brush", "cursor-eraser", "cursor-pan", "cursor-pan-grabbing");
        const isPanMode = this.tool === "pan" || this.spacePressed;
        if (forceGrabbing || (this.panning && this.panStart)) {
            host.classList.add("cursor-pan", "cursor-pan-grabbing");
            host.style.cursor = ""; // use CSS grabbing
            return;
        }
        if (isPanMode) {
            host.classList.add("cursor-pan");
            host.style.cursor = ""; // use CSS grab
            return;
        }
        // For drawing tools, hide OS cursor; self-cursor overlay renders instead
        host.style.cursor = "none";
        if (this.tool === "eraser") { host.classList.add("cursor-eraser"); } else { host.classList.add("cursor-brush"); }
    }

    // Redraws only the overlay (previews). Runs every animation frame.
    redrawOverlayLayer() {
        const c = this.overlayCanvas;
        // Clear ignoring current transform for full coverage
        this.overlayCtx.save();
        this.overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
        this.overlayCtx.clearRect(0, 0, c.width, c.height);
        this.overlayCtx.restore();

        // Draft create shape preview
        if (this.draftCreate) {
            const d = this.normalizeRect(this.draftCreate);
            this.drawShapeOutline(this.overlayCtx, d, { dashed: true });
        }

        // Selection overlay removed per request

        // Local in-progress stroke
        // For brush we preview on overlay; for eraser we erase directly on main canvas in onPointerMove
        if (this.localPoints.length >= 2 && this.tool !== "eraser") {
            this.drawStroke(this.overlayCtx, {
                points: this.localPoints,
                color: this.color,
                size: this.size,
                composite: this.tool === "eraser" ? "destination-out" : "source-over",
            });
        }

        // Remote in-progress strokes
        for (const [, progress] of this.remoteProgress) {
            if (progress.points.length >= 2) {
                this.drawStroke(this.overlayCtx, progress);
            }
        }
    }

    // Draw a smoothed polyline stroke with quadratic curves.
    drawStroke(ctx, { points, color, size, composite }) {
        if (!points || points.length < 2) return;
        ctx.save();
        ctx.lineWidth = size; // size in world units; transform scales it
        ctx.strokeStyle = color;
        ctx.globalCompositeOperation = composite || "source-over";
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length - 1; i++) {
            const midX = (points[i].x + points[i + 1].x) / 2;
            const midY = (points[i].y + points[i + 1].y) / 2;
            ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
        }
        ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
        ctx.stroke();
        ctx.restore();
    }

    // Apply a committed operation locally (either stroke or shape variants).
    applyCommit(op) {
        if (op.type === "stroke") {
            this.operations.push(op);
            this.drawStroke(this.ctx, op);
            // Clear any remote progress for that user if provided
            if (op.userId && this.remoteProgress.has(op.userId)) {
                this.remoteProgress.delete(op.userId);
            }
        } else if (op.type === "shape") {
            // Normalize into top-left + width/height if using legacy center+size
            const norm = this.normalizeIncomingShape(op);
            if (!norm) return;
            if (op.id) {
                // Server-ack shape: dedupe any matching local placeholder
                const localId = this.findMatchingLocalShapeId(norm);
                if (localId) this.shapes.delete(localId);
                this.operations.push(op);
                this.shapes.set(op.id, { ...norm, id: op.id });
                this.redrawAll();
            } else {
                // Local create: assign temporary id so redraws persist
                const tempId = `local-${Math.random().toString(36).slice(2)}`;
                const localOp = { ...op, id: tempId };
                this.operations.push(localOp);
                this.shapes.set(tempId, { ...norm, id: tempId });
                this.redrawAll();
            }
        } else if (op.type === "shape:update") {
            this.operations.push(op);
            const s = this.shapes.get(op.targetId);
            if (s) {
                if (Number.isFinite(op.x)) s.x = op.x;
                if (Number.isFinite(op.y)) s.y = op.y;
                if (Number.isFinite(op.width) && op.width > 0) s.width = op.width;
                if (Number.isFinite(op.height) && op.height > 0) s.height = op.height;
                if (typeof op.color === "string") s.color = op.color;
            }
            this.redrawAll();
        }
    }

    // Merge a remote in-progress fragment into a cached path per user.
    applyProgress(userId, progress) {
        if (progress.composite === "destination-out") {
            // Remote eraser should immediately affect the main canvas
            this.drawStroke(this.ctx, progress);
            // Clear any in-progress cache for that user
            this.remoteProgress.delete(userId);
            return;
        }
        const entry = this.remoteProgress.get(userId) || { points: [] };
        const next = {
            points: mergePoints(entry.points, progress.points),
            color: progress.color,
            size: progress.size,
            composite: progress.composite,
        };
        this.remoteProgress.set(userId, next);
    }

    // Replace local state with a full snapshot from the server and redraw.
    renderSnapshot(snapshot) {
        if (!snapshot || !Array.isArray(snapshot.operations)) return;
        this.operations = snapshot.operations.slice();
        // Rebuild shapes map
        this.shapes.clear();
        for (const op of this.operations) {
            if (op.type === "shape") {
                const s = this.normalizeIncomingShape(op);
                if (s && s.id) this.shapes.set(s.id, s);
            } else if (op.type === "shape:update" && op.targetId && this.shapes.has(op.targetId)) {
                const s = this.shapes.get(op.targetId);
                if (Number.isFinite(op.x)) s.x = op.x;
                if (Number.isFinite(op.y)) s.y = op.y;
                if (Number.isFinite(op.width) && op.width > 0) s.width = op.width;
                if (Number.isFinite(op.height) && op.height > 0) s.height = op.height;
                if (typeof op.color === "string") s.color = op.color;
            }
        }
        this.redrawAll();
    }

    /** Export only the main (committed) layer as a PNG data URL. */
    toDataURL() {
        const tmp = document.createElement("canvas");
        tmp.width = this.mainCanvas.width;
        tmp.height = this.mainCanvas.height;
        const tctx = tmp.getContext("2d");
        tctx.drawImage(this.mainCanvas, 0, 0);
        return tmp.toDataURL("image/png");
    }
}

CanvasManager.prototype.redrawAll = function () {
    // Clear and replay under current transform
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.mainCanvas.width, this.mainCanvas.height);
    // Restore transform for drawing
    const d = this.devicePixelRatio;
    this.ctx.setTransform(this.scale * d, 0, 0, this.scale * d, this.pan.x * d, this.pan.y * d);
    // 1) Draw strokes in order
    for (const op of this.operations) {
        if (op.type === "stroke") this.drawStroke(this.ctx, op);
    }
    // 2) Draw final shapes state on top
    const shapesMap = this.shapes || new Map();
    for (const [, shape] of shapesMap) {
        this.drawShape(this.ctx, shape);
    }
}

function distance(a, b) {
    const dx = a.x - b.x; const dy = a.y - b.y; return Math.hypot(dx, dy);
}

// Simple point simplification (RDP-lite). Keep points that add curvature or are apart.
function simplifyPoints(points) {
    if (points.length <= 2) return points.slice();
    const threshold = 0.5; // in device pixels (already scaled)
    const simplified = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
        const a = simplified[simplified.length - 1];
        const b = points[i];
        const c = points[i + 1];
        const ab = distance(a, b);
        const bc = distance(b, c);
        const ac = distance(a, c);
        const deviation = ab + bc - ac;
        if (deviation > threshold || ab > threshold) simplified.push(b);
    }
    simplified.push(points[points.length - 1]);
    return simplified;
}

function mergePoints(existing, incoming) {
    if (!existing || existing.length === 0) return incoming.slice();
    if (!incoming || incoming.length === 0) return existing.slice();
    // Avoid duplicating the shared last point
    const last = existing[existing.length - 1];
    const start = incoming[0];
    const merged = existing.slice();
    if (distance(last, start) < 0.01) {
        merged.push(...incoming.slice(1));
    } else {
        merged.push(...incoming);
    }
    return merged;
}



// Apply remote in-flight shape transform
CanvasManager.prototype.applyShapeProgress = function (payload) {
    if (!payload || !payload.id) return;
    const s = this.shapes.get(payload.id);
    if (!s) return;
    if (Number.isFinite(payload.x)) s.x = payload.x;
    if (Number.isFinite(payload.y)) s.y = payload.y;
    if (Number.isFinite(payload.width) && payload.width > 0) s.width = payload.width;
    if (Number.isFinite(payload.height) && payload.height > 0) s.height = payload.height;
    this.redrawAll();
};

// Apply remote in-flight text transform
CanvasManager.prototype.applyTextProgress = function (payload) {
    if (!payload || !payload.id) return;
    const t = this.texts.get(payload.id);
    if (!t) return;
    if (Number.isFinite(payload.x)) t.x = payload.x;
    if (Number.isFinite(payload.y)) t.y = payload.y;
    if (Number.isFinite(payload.fontSize) && payload.fontSize > 0) t.fontSize = payload.fontSize;
    this.redrawAll();
};
// Compute approximate text bounds in world coordinates for hit testing.
CanvasManager.prototype.measureTextBounds = function (t) {
    if (!t || typeof t.text !== "string") return null;
    const d = this.devicePixelRatio;
    this.ctx.save();
    const fontSize = Math.max(8, Number(t.fontSize ?? t.size) || 16);
    this.ctx.font = `${fontSize}px ${t.fontFamily || "Inter, system-ui, sans-serif"}`;
    const metrics = this.ctx.measureText(t.text);
    this.ctx.restore();
    const width = metrics.width;
    const height = fontSize * 1.3;
    const x = t.x;
    const y = t.y;
    return { x, y, width, height };
};

CanvasManager.prototype.hitTestText = function (x, y) {
    // Iterate and pick last hit (top-most among text layer)
    let hit = null;
    for (const [id, t] of this.texts) {
        const b = this.measureTextBounds(t);
        if (!b) continue;
        if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) hit = id;
    }
    return hit;
};

// Public helpers for resizing selected text from UI
CanvasManager.prototype.hasSelectedText = function () {
    return !!this.selectedTextId && this.texts.has(this.selectedTextId);
};
CanvasManager.prototype.getSelectedTextFontSize = function () {
    if (!this.hasSelectedText()) return null;
    return this.texts.get(this.selectedTextId).fontSize;
};
CanvasManager.prototype.updateSelectedTextFontSize = function (size) {
    if (!this.hasSelectedText()) return;
    const t = this.texts.get(this.selectedTextId);
    const next = Math.max(8, Number(size) || 16);
    if (t.fontSize === next) return;
    t.fontSize = next;
    this.redrawAll();
    this.onCommit?.({ type: "text:update", targetId: t.id, fontSize: next });
};

// Draw final shape geometry at current transform.
CanvasManager.prototype.drawShape = function (ctx, op) {
    if (!op || !op.shape) return;
    // Support legacy center+size or new x,y,width,height (x,y top-left)
    let x = op.x, y = op.y, w = op.width, h = op.height;
    if (!Number.isFinite(w) || !Number.isFinite(h)) {
        const size = Math.max(1, Number(op.size) || 16);
        w = size; h = size; x = (op.x ?? 0) - size / 2; y = (op.y ?? 0) - size / 2;
    }
    ctx.save();
    ctx.strokeStyle = op.color || "#1f2937";
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (op.shape === "circle") {
        const cx = x + w / 2, cy = y + h / 2;
        const r = Math.min(w, h) / 2;
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
    } else if (op.shape === "square") {
        // Use strokeRect for crisp rectangle outline
        ctx.strokeRect(x, y, w, h);
    } else if (op.shape === "triangle") {
        // Upward equilateral triangle inside the box
        const cx = x + w / 2, cy = y + h / 2;
        const size = Math.min(w, h);
        const hh = (Math.sqrt(3) / 2) * size;
        const p1 = { x: cx, y: cy - (2 / 3) * hh };
        const p2 = { x: cx - size / 2, y: cy + (1 / 3) * hh };
        const p3 = { x: cx + size / 2, y: cy + (1 / 3) * hh };
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineTo(p3.x, p3.y);
        ctx.closePath();
        ctx.stroke();
    }
    ctx.restore();
}

// Draw a temporary outline for in-progress shape creation.
CanvasManager.prototype.drawShapeOutline = function (ctx, op, { dashed } = {}) {
    const { x, y, width: w, height: h } = op;
    ctx.save();
    if (dashed) ctx.setLineDash([4, 4]);
    ctx.strokeStyle = op.color || "#1f2937";
    ctx.lineWidth = 1;
    if (op.shape === "circle") {
        const cx = x + w / 2, cy = y + h / 2, r = Math.min(w, h) / 2;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    } else if (op.shape === "square") {
        ctx.strokeRect(x, y, w, h);
    } else if (op.shape === "triangle") {
        const cx = x + w / 2, cy = y + h / 2;
        const size = Math.min(w, h);
        const hh = (Math.sqrt(3) / 2) * size;
        const p1 = { x: cx, y: cy - (2 / 3) * hh };
        const p2 = { x: cx - size / 2, y: cy + (1 / 3) * hh };
        const p3 = { x: cx + size / 2, y: cy + (1 / 3) * hh };
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.closePath(); ctx.stroke();
    }
    ctx.restore();
}

CanvasManager.prototype.drawSelection = function (ctx, shape) {
    const { x, y, width: w, height: h } = shape;
    ctx.save();
    // selection rectangle
    ctx.strokeStyle = "#6366f1";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(x, y, w, h);
    // handles (keep ~8px on screen)
    const s = Math.max(6, Math.min(12, 8 / this.scale));
    const half = s / 2;
    const pts = [
        { k: "nw", x, y },
        { k: "ne", x: x + w, y },
        { k: "sw", x, y: y + h },
        { k: "se", x: x + w, y: y + h },
    ];
    ctx.setLineDash([]);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#6366f1";
    for (const p of pts) {
        ctx.beginPath();
        ctx.rect(p.x - half, p.y - half, s, s);
        ctx.fill(); ctx.stroke();
    }
    ctx.restore();
}

// Bring incoming shape ops to a normalized "top-left + width/height" form.
CanvasManager.prototype.normalizeIncomingShape = function (op) {
    if (!op) return null;
    const color = op.color || "#1f2937";
    if (Number.isFinite(op.width) && Number.isFinite(op.height)) {
        return { id: op.id, shape: op.shape, x: op.x, y: op.y, width: op.width, height: op.height, color };
    }
    const size = Math.max(1, Number(op.size) || 16);
    return { id: op.id, shape: op.shape, x: (op.x ?? 0) - size / 2, y: (op.y ?? 0) - size / 2, width: size, height: size, color };
}

// Normalize drag draft to top-left box and clamp minimal size.
CanvasManager.prototype.normalizeRect = function (draft) {
    const x1 = draft.x, y1 = draft.y, x2 = draft.x + draft.width, y2 = draft.y + draft.height;
    const x = Math.min(x1, x2), y = Math.min(y1, y2);
    const w = Math.max(1, Math.abs(x2 - x1)), h = Math.max(1, Math.abs(y2 - y1));
    return { shape: draft.shape, x, y, width: w, height: h, color: draft.color };
}

// Return the id of the top-most shape under a point (if any).
CanvasManager.prototype.hitTestShape = function (x, y) {
    // Iterate in insertion order and pick last hit (top-most among shapes layer)
    let hit = null;
    for (const [id, s] of this.shapes) {
        if (x >= s.x && x <= s.x + s.width && y >= s.y && y <= s.y + s.height) hit = id;
    }
    return hit;
}

// Return which resize handle (if any) is under the point.
CanvasManager.prototype.hitTestHandle = function (shape, x, y) {
    if (!shape) return null;
    const s = Math.max(6, Math.min(12, 8 / this.scale));
    const half = s / 2;
    const boxes = [
        { k: "nw", x: shape.x, y: shape.y },
        { k: "ne", x: shape.x + shape.width, y: shape.y },
        { k: "sw", x: shape.x, y: shape.y + shape.height },
        { k: "se", x: shape.x + shape.width, y: shape.y + shape.height },
    ].map(p => ({ k: p.k, x: p.x - half, y: p.y - half, w: s, h: s }));
    for (const b of boxes) {
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.k;
    }
    return null;
}

// Try to link a just-acknowledged shape from server to a previous local placeholder.
CanvasManager.prototype.findMatchingLocalShapeId = function (shape) {
    // Find a 'local-' id shape that closely matches this server-ack shape
    const cx = shape.x + shape.width / 2;
    const cy = shape.y + shape.height / 2;
    for (const [id, s] of this.shapes) {
        if (!id.startsWith('local-')) continue;
        if (s.shape !== shape.shape) continue;
        const scx = s.x + s.width / 2;
        const scy = s.y + s.height / 2;
        const centerDist = Math.hypot(scx - cx, scy - cy);
        const sizeDiff = Math.abs(s.width - shape.width) + Math.abs(s.height - shape.height);
        if (centerDist < 4 && sizeDiff < 6) return id;
    }
    return null;
}


