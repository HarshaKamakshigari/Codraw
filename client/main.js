// App entry: wires UI, canvas rendering, and realtime sync together.
import { CanvasManager } from "./canvas.js";
import { RealtimeClient } from "./websocket.js";

// Grab references to UI elements we interact with.
const canvasHost = document.getElementById("canvasHost");
const colorPicker = document.getElementById("colorPicker");
const sizeSlider = document.getElementById("sizeSlider");
const sizeLabel = document.getElementById("sizeLabel");

const railAllButtons = Array.from(document.querySelectorAll('.left-rail .rail-btn'));
const cursorLayer = document.getElementById("cursorLayer");
const userList = document.getElementById("userList");

const reactionBtn = document.getElementById("reactionBtn");
const reactionPalette = document.getElementById("reactionPalette");
const reactionsLayer = document.getElementById("reactionsLayer");
const usersBtn = document.getElementById("usersBtn");
const usersDropdown = document.getElementById("usersDropdown");
const zoomInBtn = document.getElementById("zoomIn");
const zoomOutBtn = document.getElementById("zoomOut");
const zoomValueEl = document.getElementById("zoomValue");
const settingsBtn = document.getElementById("settingsBtn");
const brushSubrail = document.getElementById("brushSubrail");
const shapesBtn = document.getElementById("shapesBtn");
const shapesSubrail = document.getElementById("shapesSubrail");
const railBox = document.querySelector(".left-rail .rail-box");
const clearAllBtn = document.getElementById("clearAllBtn");
const splash = document.getElementById("splash");

let selfUser = null;
const userIdToCursorEl = new Map();
const userIdToUser = new Map();

function setZoomLabel(scale) {
    if (zoomValueEl) zoomValueEl.textContent = `${Math.round(scale * 100)}%`;
}

// Owns drawing, transforms, and tool logic. Emits progress/commit events.
const canvas = new CanvasManager({
    canvasHost,
    onProgress: (progress) => client.sendProgress(progress),
    onCommit: (op) => client.sendCommit(op),
    onShapeProgress: (payload) => client.sendShapeProgress(payload),
    // Avoid referencing canvas during constructor time; use provided scale
    onTransform: ({ scale }) => setZoomLabel(scale),
});

// Handles socket lifecycle and event fan-out to our handlers.
const client = new RealtimeClient({
    onInit: ({ user, snapshot, users }) => {
        selfUser = user;
        renderPresence(users);
        canvas.renderSnapshot(snapshot);
    },
    onProgress: ({ userId, ...progress }) => {
        if (userId === selfUser?.userId) return;
        canvas.applyProgress(userId, progress);
    },
    onCommit: (op) => {
        canvas.applyCommit(op);
    },
    onState: (snapshot) => {
        console.log('[client] state:full received', { version: snapshot?.version, opCount: snapshot?.operations?.length });
        canvas.renderSnapshot(snapshot);
    },
    onPresenceJoin: ({ user }) => addPresence(user),
    onPresenceLeave: ({ userId }) => removePresence(userId),
    onCursor: ({ userId, x, y, color }) => updateCursor(userId, x, y, color),
    onReaction: ({ emoji }) => spawnReaction(emoji),
    onShapeProgress: ({ userId, ...payload }) => {
        if (userId === selfUser?.userId) return;
        canvas.applyShapeProgress?.(payload);
    },
});

railAllButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
        railAllButtons.forEach(b => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        const tool = btn.getAttribute("data-tool");
        if (tool) { canvas.setTool(tool); currentTool = tool; updateSelfCursorAppearance(); }
    });
});

if (colorPicker) colorPicker.addEventListener("input", (e) => {
    const value = e.target.value;
    canvas.setColor(value);
    updateSelfCursorAppearance();
});

if (sizeSlider) sizeSlider.addEventListener("input", (e) => {
    const size = Number(e.target.value);
    if (sizeLabel) sizeLabel.textContent = `${size}px`;
    canvas.setSize(size);
    updateSelfCursorAppearance();
});

const topUndoBtn = document.getElementById("topUndoBtn");
const topRedoBtn = document.getElementById("topRedoBtn");
if (topUndoBtn) topUndoBtn.addEventListener("click", () => client.sendUndo());
if (topRedoBtn) topRedoBtn.addEventListener("click", () => client.sendRedo());

// Settings popover toggle
if (settingsBtn && brushSubrail) {
    settingsBtn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        // Close other subrails to avoid overlap
        if (shapesSubrail) { shapesSubrail.hidden = true; shapesBtn?.classList.remove('is-active'); }
        brushSubrail.hidden = !brushSubrail.hidden;
        settingsBtn.classList.toggle('is-active', !brushSubrail.hidden);
    });
    document.addEventListener("click", (e) => {
        if (!brushSubrail || !settingsBtn) return;
        const inside = brushSubrail.contains(e.target) || settingsBtn.contains(e.target);
        if (!inside) { brushSubrail.hidden = true; settingsBtn.classList.remove('is-active'); }
    });
}

// Shapes popover toggle and selection
if (shapesBtn && shapesSubrail) {
    // Default shape
    if (canvas.setShapeType) canvas.setShapeType("circle");
    shapesBtn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        // Close other subrails to avoid overlap
        if (brushSubrail) { brushSubrail.hidden = true; settingsBtn?.classList.remove('is-active'); }
        // Anchor to the triggering button
        if (railBox) {
            const top = shapesBtn.offsetTop || 0;
            shapesSubrail.style.top = `${top}px`;
        }
        shapesSubrail.hidden = !shapesSubrail.hidden;
        shapesBtn.classList.toggle('is-active', !shapesSubrail.hidden);
        // Ensure tool is shape when opening
        canvas.setTool("shape"); currentTool = "shape"; updateSelfCursorAppearance();
    });
    // Shape selection
    shapesSubrail.addEventListener("click", (e) => {
        const btn = e.target.closest('[data-shape]');
        if (!btn) return;
        const shape = btn.getAttribute('data-shape');
        if (canvas.setShapeType) canvas.setShapeType(shape);
        // Keep tool on shape and close popover
        canvas.setTool("shape"); 
        currentTool = "shape"; 
        updateSelfCursorAppearance();
        // Update active state for shape buttons
        shapesSubrail.querySelectorAll('[data-shape]').forEach(b => {
            b.classList.toggle('is-active', b === btn);
        });
    });
    // Close when clicking outside
    document.addEventListener("click", (e) => {
        const insideShapes = shapesSubrail.contains(e.target) || shapesBtn.contains(e.target);
        const insideBrush = brushSubrail?.contains(e.target) || settingsBtn?.contains(e.target);
        if (!insideShapes) { shapesSubrail.hidden = true; shapesBtn.classList.remove('is-active'); }
        if (!insideBrush && brushSubrail) { brushSubrail.hidden = true; settingsBtn?.classList.remove('is-active'); }
    });
}

// Clear board (everyone)
if (clearAllBtn) clearAllBtn.addEventListener("click", () => {
    console.log('[client] clearAllBtn clicked');
    client.sendClearAll((res) => {
        if (!res?.ok) {
            console.warn('[client] clearAll failed', res);
        }
    });
});

// Keyboard shortcuts
window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault(); client.sendUndo();
    } else if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z")) {
        e.preventDefault(); client.sendRedo();
    }
});

// Cursor broadcasting
document.addEventListener("pointermove", (e) => {
    const rect = canvasHost.getBoundingClientRect();
    const scale = canvas.getScale();
    const pan = canvas.getPan();
    const worldX = (e.clientX - rect.left - pan.x) / scale;
    const worldY = (e.clientY - rect.top - pan.y) / scale;
    client.sendCursor({ x: worldX, y: worldY, color: selfUser?.color });
    // Self cursor overlay (size-aware)
    const isPan = canvasHost.classList.contains('cursor-pan') || canvasHost.classList.contains('cursor-pan-grabbing');
    if (isPan) { hideSelfCursor(); return; }
    ensureSelfCursor();
    positionSelfCursor(e.clientX - rect.left, e.clientY - rect.top);
    updateSelfCursorAppearance();
});

canvasHost.addEventListener('pointerleave', () => hideSelfCursor());

// Self brush/eraser cursor state
let currentTool = "brush";
let isSelfDrawing = false;
let selfCursorEl = null;

function ensureSelfCursor() {
    if (selfCursorEl) return;
    selfCursorEl = document.createElement('div');
    selfCursorEl.className = 'self-cursor';
    const tip = document.createElement('div'); tip.className = 'tip';
    const icon = document.createElement('span'); icon.classList.add('mi', 'material-symbols-rounded', 'icon');
    icon.style.fontSize = '22px';
    selfCursorEl.appendChild(tip); selfCursorEl.appendChild(icon);
    cursorLayer.appendChild(selfCursorEl);
}

function hideSelfCursor() { if (selfCursorEl) selfCursorEl.style.display = 'none'; }
function positionSelfCursor(x, y) { if (!selfCursorEl) return; selfCursorEl.style.display = 'flex'; selfCursorEl.style.left = `${x}px`; selfCursorEl.style.top = `${y}px`; }
function updateSelfCursorAppearance() {
    if (!selfCursorEl) return;
    const tip = selfCursorEl.querySelector('.tip');
    const icon = selfCursorEl.querySelector('.mi.material-symbols-rounded.icon');
    // Hide the size ring entirely per request
    tip.style.display = 'none';
    if (currentTool === 'eraser') {
        icon.textContent = 'ink_eraser';
        icon.style.color = '#374151';
        // Align icon tip to pointer (eraser hotspot ~8x16)
        selfCursorEl.style.transform = 'translate(-8px, -16px)';
    } else {
        const col = colorPicker?.value || '#1f2937';
        icon.textContent = 'brush';
        icon.style.color = col;
        // Align icon tip to pointer (brush hotspot ~6x20)
        selfCursorEl.style.transform = 'translate(-6px, -20px)';
    }
}

function renderPresence(users) {
    userList.innerHTML = "";
    users.forEach(addPresence);
}

function addPresence(user) {
    const li = document.createElement("li");
    li.className = "user-item";
    li.dataset.userId = user.userId;
    const dot = document.createElement("span");
    dot.className = "user-dot";
    dot.style.background = user.color;
    const name = document.createElement("span");
    name.textContent = user.displayName;
    li.appendChild(dot); li.appendChild(name);
    userList.appendChild(li);
    userIdToUser.set(user.userId, user);
}

function removePresence(userId) {
    const el = userList.querySelector(`[data-user-id="${userId}"]`);
    el?.remove();
    const cursor = userIdToCursorEl.get(userId);
    cursor?.remove();
    userIdToCursorEl.delete(userId);
    userIdToUser.delete(userId);
}

function updateCursor(userId, x, y, color) {
    if (!userId || !Number.isFinite(x) || !Number.isFinite(y)) return;
    let el = userIdToCursorEl.get(userId);
    if (!el) {
        el = document.createElement("div");
        el.className = "cursor pointer";
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.classList.add("cursor-pointer-arrow");
        // Arrow path with tip at (0,0)
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", "M0 0 L12 8 L8 9 L11 20 L7 20 L5 9 L2 10 Z");
        path.setAttribute("fill", color || "#111827");
        path.setAttribute("stroke", "#ffffff");
        path.setAttribute("stroke-width", "0.75");
        svg.appendChild(path);
        const nameEl = document.createElement("span");
        nameEl.className = "cursor-pointer-name";
        nameEl.textContent = userIdToUser.get(userId)?.displayName || userId;
        el.appendChild(svg);
        el.appendChild(nameEl);
        userIdToCursorEl.set(userId, el);
        cursorLayer.appendChild(el);
    }
    // Update arrow color
    const path = el.querySelector('path');
    if (path && color) path.setAttribute('fill', color);
    const nameEl = el.querySelector('.cursor-pointer-name');
    if (nameEl && color) { const t = computeTheme(color); nameEl.style.borderColor = t.border; nameEl.style.color = t.text; nameEl.style.background = t.bg; }
    // Convert world -> screen so tip is exactly at pointer
    const scale = canvas.getScale();
    const pan = canvas.getPan();
    const sx = pan.x + x * scale;
    const sy = pan.y + y * scale;
    el.style.left = `${sx}px`;
    el.style.top = `${sy}px`;
}

function computeTheme(hex) {
    // Basic hex to rgba with soft background
    const { r, g, b } = hexToRgb(hex || '#6366f1');
    return {
        bg: `rgba(${r}, ${g}, ${b}, 0.16)`,
        border: `rgba(${r}, ${g}, ${b}, 0.35)`,
        text: `rgb(${r}, ${g}, ${b})`,
    };
}

function hexToRgb(hex) {
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(ch => ch + ch).join('');
    const num = parseInt(c, 16);
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

// Zoom controls
if (zoomInBtn) zoomInBtn.addEventListener("click", () => { canvas.setScale(canvas.getScale() + 0.1); setZoomLabel(canvas.getScale()); });
if (zoomOutBtn) zoomOutBtn.addEventListener("click", () => { canvas.setScale(canvas.getScale() - 0.1); setZoomLabel(canvas.getScale()); });
setZoomLabel(1);

// Splash auto-hide (2.4s delay, 0.6s fade)
if (splash) {
    setTimeout(() => {
        splash.classList.add('is-hidden');
        // Remove after transition ends
        setTimeout(() => splash.remove(), 700);
    }, 2400);
}

// Reactions
if (reactionBtn) reactionBtn.addEventListener("click", () => {
    if (!reactionPalette) return;
    reactionPalette.hidden = !reactionPalette.hidden;
});
if (reactionPalette) reactionPalette.addEventListener("click", (e) => {
    const btn = e.target.closest('.emoji');
    if (!btn) return;
    const emoji = btn.textContent.trim();
    client.sendReaction(emoji);
    reactionPalette.hidden = true;
});

// Users dropdown
if (usersBtn) usersBtn.addEventListener("click", () => {
    if (!usersDropdown) return; usersDropdown.hidden = !usersDropdown.hidden;
});
document.addEventListener("click", (e) => {
    if (!usersDropdown || !usersBtn) return;
    const inside = usersDropdown.contains(e.target) || usersBtn.contains(e.target);
    if (!inside) usersDropdown.hidden = true;
});

// Lightweight floating emoji animation.
function spawnReaction(emoji) {
    const el = document.createElement("div");
    el.className = "reaction-float";
    el.textContent = emoji;
    el.style.left = `${50 + (Math.random() * 20 - 10)}%`;
    reactionsLayer.appendChild(el);
    setTimeout(() => el.remove(), 1700);
}


