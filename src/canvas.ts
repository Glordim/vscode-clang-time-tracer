// --- Configuration & Constants ---

const CONFIG = {
    TIMELINE: {
        HEIGHT: 40,
        MIN_TICK_GAP: 160,
        LABEL_FONT: "10px sans-serif",
        TICK_COLOR: "#555",
        TEXT_COLOR: "#888",
        BG_COLOR: "#1e1e1e"
    },
    VIEW: {
        MARGIN_SIDE: 40,
        DEFAULT_ROW_HEIGHT: 24,
        DEFAULT_TRACK_SPACING: 30,
        ZOOM_SENSITIVITY: 0.15,
        MAX_SCALE: 10000
    },
    RENDERING: {
        EVENT_FONT: "bold 11px sans-serif",
        DETAIL_FONT: "10px sans-serif",
        ROUNDING: 2,
        MIN_WIDTH_FOR_TEXT: 20,
        MIN_WIDTH_FOR_DETAIL: 120
    }
};

// --- Interfaces ---

interface TraceEvent {
    ph: 'X' | 'b' | 'e' | string;
    tid: number | string;
    cat?: string;
    name: string;
    ts: number;
    dur?: number;
    args?: {
        detail?: string;
        [key: string]: any;
    };
}

interface ProcessedEvent {
    name: string;
    detail: string;
    start: number;
    dur: number;
    end: number;
    tid: number | string;
    depth: number;
}

interface Thread {
    tid: string;
    sourceEvents: ProcessedEvent[];
    mainEvents: ProcessedEvent[];
    maxSourceDepth: number;
    maxMainDepth: number;
}

interface ViewState {
    x: number;
    y: number;
    scale: number;
    rowHeight: number;
    trackSpacing: number;
}

// --- Initialization ---

const vscode = typeof (window as any).acquireVsCodeApi === 'function' ? (window as any).acquireVsCodeApi() : null;

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const tooltip = document.getElementById('tooltip') as HTMLDivElement;
const contextMenu = document.getElementById('context-menu') as HTMLDivElement;

let threads: Thread[] = [];
let maxTraceTime = 0;
let totalContentHeight = 0;
let selectedEvent: ProcessedEvent | null = null;
let rightClickedEvent: ProcessedEvent | null = null;

let view: ViewState = {
    x: CONFIG.VIEW.MARGIN_SIDE,
    y: 60,
    scale: 0.1,
    rowHeight: CONFIG.VIEW.DEFAULT_ROW_HEIGHT,
    trackSpacing: CONFIG.VIEW.DEFAULT_TRACK_SPACING
};

function getClientWidth(): number {
    return document.documentElement.clientWidth || window.innerWidth;
}

function resetView(): void {
    if (maxTraceTime <= 0) { return; }

    canvas.width = getClientWidth();
    canvas.height = window.innerHeight;

    const marginY = CONFIG.TIMELINE.HEIGHT + 20;

    view.scale = (canvas.width - (CONFIG.VIEW.MARGIN_SIDE * 2)) / maxTraceTime;
    view.x = CONFIG.VIEW.MARGIN_SIDE;
    view.y = marginY;

    clampView();
    render();
}

// --- Logic ---

function preprocess(data: { traceEvents: TraceEvent[] }): void {
    const events = data.traceEvents || [];
    const threadMap: Record<string, { sources: ProcessedEvent[], main: ProcessedEvent[] }> = {};
    const openEvents: Record<string, TraceEvent[]> = {};

    maxTraceTime = 0;

    events.forEach(e => {
        if (e.tid === undefined) { return; }
        const tidStr = e.tid.toString();
        if (!threadMap[tidStr]) { threadMap[tidStr] = { sources: [], main: [] }; }

        const isSource = e.cat === "Source" || e.name === "Source";

        if (e.ph === 'X') {
            const end = e.ts + (e.dur || 0);
            const proc: ProcessedEvent = {
                name: e.name,
                detail: e.args?.detail || "",
                start: e.ts,
                dur: e.dur || 0,
                end: end,
                tid: tidStr,
                depth: 0
            };
            if (isSource) { threadMap[tidStr].sources.push(proc); }
            else { threadMap[tidStr].main.push(proc); }
            if (end > maxTraceTime) { maxTraceTime = end; }
        }
        else if (e.ph === 'b') {
            const key = `${tidStr}-${e.name}`;
            if (!openEvents[key]) { openEvents[key] = []; }
            openEvents[key].push(e);
        }
        else if (e.ph === 'e') {
            const key = `${tidStr}-${e.name}`;
            const startEvent = openEvents[key]?.pop();
            if (startEvent) {
                const proc: ProcessedEvent = {
                    name: startEvent.name,
                    detail: startEvent.args?.detail || "",
                    start: startEvent.ts,
                    dur: e.ts - startEvent.ts,
                    end: e.ts,
                    tid: tidStr,
                    depth: 0
                };
                if (isSource) { threadMap[tidStr].sources.push(proc); }
                else { threadMap[tidStr].main.push(proc); }
                if (e.ts > maxTraceTime) { maxTraceTime = e.ts; }
            }
        }
    });

    threads = Object.keys(threadMap).map(tid => {
        const tData = threadMap[tid];

        const computeDepth = (evs: ProcessedEvent[]) => {
            evs.sort((a, b) => a.start - b.start || b.dur - a.dur);
            const stack: ProcessedEvent[] = [];
            let maxD = 0;
            evs.forEach(ev => {
                while (stack.length > 0 && ev.start >= stack[stack.length - 1].end) {
                    stack.pop();
                }
                ev.depth = stack.length;
                maxD = Math.max(maxD, ev.depth);
                stack.push(ev);
            });
            return maxD;
        };

        return {
            tid,
            sourceEvents: tData.sources,
            mainEvents: tData.main,
            maxSourceDepth: computeDepth(tData.sources),
            maxMainDepth: computeDepth(tData.main)
        };
    });

    updateTotalHeight();
}

function updateTotalHeight(): void {
    totalContentHeight = 0;
    threads.forEach(t => {
        const sourceH = (t.maxSourceDepth + 1) * view.rowHeight;
        const mainH = (t.maxMainDepth + 1) * view.rowHeight;
        totalContentHeight += 20 + sourceH + 10 + mainH + view.trackSpacing;
    });
}

function clampView(): void {
    const marginY = CONFIG.TIMELINE.HEIGHT + 10;
    const contentWidth = maxTraceTime * view.scale;
    const availableWidth = canvas.width;

    if (contentWidth > availableWidth - (CONFIG.VIEW.MARGIN_SIDE * 2)) {
        const minX = availableWidth - contentWidth - CONFIG.VIEW.MARGIN_SIDE;
        const maxX = CONFIG.VIEW.MARGIN_SIDE;
        if (view.x > maxX) { view.x = maxX; }
        if (view.x < minX) { view.x = minX; }
    } else {
        view.x = CONFIG.VIEW.MARGIN_SIDE;
    }

    const minY = canvas.height - totalContentHeight - 40;
    if (totalContentHeight > canvas.height - marginY) {
        if (view.y > marginY) { view.y = marginY; }
        if (view.y < minY) { view.y = minY; }
    } else {
        view.y = marginY;
    }
}

// --- Rendering ---

function getColor(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return `hsl(${Math.abs(hash % 360)}, 50%, 45%)`;
}

function shortenPath(text: string): string {
    if (!text) { return ""; }
    const parts = text.split(/[\\\/]/);
    return parts[parts.length - 1] || text;
}

function renderTimeline(): void {
    ctx.fillStyle = CONFIG.TIMELINE.BG_COLOR;
    ctx.fillRect(0, 0, canvas.width, CONFIG.TIMELINE.HEIGHT);

    ctx.strokeStyle = CONFIG.TIMELINE.TICK_COLOR;
    ctx.fillStyle = CONFIG.TIMELINE.TEXT_COLOR;
    ctx.font = CONFIG.TIMELINE.LABEL_FONT;
    ctx.lineWidth = 1;

    const timePerPixel = 1 / view.scale;
    const targetTimeGap = CONFIG.TIMELINE.MIN_TICK_GAP * timePerPixel;

    const log = Math.floor(Math.log10(targetTimeGap));
    const pow = Math.pow(10, log);

    let step = pow;
    if (targetTimeGap / pow > 5) { step = 5 * pow; }
    else if (targetTimeGap / pow > 2.5) { step = 2.5 * pow; }
    else if (targetTimeGap / pow > 2) { step = 2 * pow; }

    const startTime = (0 - view.x) / view.scale;
    const endTime = (canvas.width - view.x) / view.scale;
    const firstTick = Math.ceil(startTime / step) * step;

    const useMs = step >= 1000;

    for (let t = firstTick; t <= endTime; t += step) {
        const x = t * view.scale + view.x;
        if (x < 0 || x > canvas.width) { continue; }

        ctx.beginPath();
        ctx.moveTo(x, 10);
        ctx.lineTo(x, CONFIG.TIMELINE.HEIGHT - 18);
        ctx.stroke();

        let label = useMs ? (t / 1000).toFixed(2) + " ms" : Math.round(t).toString() + " μs";

        const textWidth = ctx.measureText(label).width;
        ctx.fillText(label, x - textWidth / 2, CONFIG.TIMELINE.HEIGHT - 5);
    }

    ctx.strokeStyle = "#333";
    ctx.beginPath();
    ctx.moveTo(0, CONFIG.TIMELINE.HEIGHT);
    ctx.lineTo(canvas.width, CONFIG.TIMELINE.HEIGHT);
    ctx.stroke();
}

function drawEvent(ev: ProcessedEvent, rowOffsetY: number) {
    const x = (ev.start * view.scale) + view.x;
    const w = ev.dur * view.scale;
    const y = rowOffsetY + (ev.depth * view.rowHeight);

    if (x + w < 0 || x > canvas.width || y + view.rowHeight < 0 || y > canvas.height) { return; }

    const rectH = view.rowHeight - 1;
    const rectW = Math.max(0.5, w);

    ctx.fillStyle = getColor(ev.name);
    ctx.beginPath();
    ctx.roundRect(x, y, rectW, rectH, CONFIG.RENDERING.ROUNDING);
    ctx.fill();

    if (selectedEvent === ev) {
        ctx.strokeStyle = "white";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
        ctx.fill();
    }

    if (w > CONFIG.RENDERING.MIN_WIDTH_FOR_TEXT) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x, y, rectW, rectH, CONFIG.RENDERING.ROUNDING);
        ctx.clip();

        const textX = Math.max(x, 0) + 4;
        ctx.font = CONFIG.RENDERING.EVENT_FONT;

        if (textX < x + w - 5) {
            ctx.fillStyle = "white";
            ctx.fillText(ev.name, textX, y + 16);

            if (ev.detail && w > CONFIG.RENDERING.MIN_WIDTH_FOR_DETAIL) {
                const nameWidth = ctx.measureText(ev.name).width;
                ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
                ctx.font = CONFIG.RENDERING.DETAIL_FONT;
                ctx.fillText(shortenPath(ev.detail), textX + nameWidth + 8, y + 16);
            }
        }
        ctx.restore();
    }
}

function render(): void {
    canvas.width = getClientWidth();
    canvas.height = window.innerHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let currentY = view.y;

    threads.forEach((thread) => {
        const sourceH = (thread.maxSourceDepth + 1) * view.rowHeight;
        const mainH = (thread.maxMainDepth + 1) * view.rowHeight;
        const totalThreadH = 20 + sourceH + 10 + mainH + view.trackSpacing;

        // Culling
        if (currentY + totalThreadH < CONFIG.TIMELINE.HEIGHT || currentY > canvas.height) {
            currentY += totalThreadH;
            return;
        }

        // --- Draw Source Events ---
        thread.sourceEvents.forEach(ev => {
            drawEvent(ev, currentY + 20);
        });

        // --- Draw Main Events ---
        const mainOffsetY = currentY + 20 + sourceH + 10;
        thread.mainEvents.forEach(ev => {
            drawEvent(ev, mainOffsetY);
        });

        // Separator line
        ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
        ctx.beginPath();
        ctx.moveTo(0, currentY + totalThreadH - view.trackSpacing / 2);
        ctx.lineTo(canvas.width, currentY + totalThreadH - view.trackSpacing / 2);
        ctx.stroke();

        currentY += totalThreadH;
    });

    renderTimeline();
}

// --- Interactions ---

let isDragging = false;
let lastMouse = { x: 0, y: 0 };

canvas.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button === 0) {
        isDragging = true;
        lastMouse = { x: e.clientX, y: e.clientY };
        canvas.style.cursor = 'grabbing';
    }
});

window.addEventListener('mousemove', (e: MouseEvent) => {
    if (isDragging) {
        view.x += e.clientX - lastMouse.x;
        view.y += e.clientY - lastMouse.y;
        lastMouse = { x: e.clientX, y: e.clientY };
        clampView();
        render();
    } else {
        updateTooltip(e);
    }
});

window.addEventListener('mouseup', () => {
    isDragging = false;
    canvas.style.cursor = 'default';
});

canvas.addEventListener('click', (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    const ev = getEventAtPosition(e.clientX - rect.left, e.clientY - rect.top);
    if (ev !== selectedEvent) {
        selectedEvent = ev;
        render();
    }
});

canvas.addEventListener('dblclick', (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    const ev = getEventAtPosition(e.clientX - rect.left, e.clientY - rect.top);

    if (ev && ev.detail && vscode) {
        vscode.postMessage({
            command: 'openFile',
            path: ev.detail
        });
    }
});

canvas.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    rightClickedEvent = getEventAtPosition(mouseX, mouseY);

    if (rightClickedEvent) {
        selectedEvent = rightClickedEvent;
        render();

        tooltip.style.display = 'none';
        contextMenu.style.display = 'block';
        contextMenu.style.left = `${e.clientX}px`;
        contextMenu.style.top = `${e.clientY}px`;
    } else {
        contextMenu.style.display = 'none';
    }
});

window.addEventListener('click', () => {
    contextMenu.style.display = 'none';
});

canvas.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? (1 - CONFIG.VIEW.ZOOM_SENSITIVITY) : (1 + CONFIG.VIEW.ZOOM_SENSITIVITY);
    const mouseWorldX = (e.clientX - view.x) / view.scale;

    const minScale = (canvas.width - (CONFIG.VIEW.MARGIN_SIDE * 2)) / maxTraceTime;
    let newScale = view.scale * delta;
    newScale = Math.max(minScale, Math.min(newScale, CONFIG.VIEW.MAX_SCALE));

    view.scale = newScale;
    view.x = e.clientX - mouseWorldX * view.scale;

    clampView();
    render();
}, { passive: false });

function getEventAtPosition(mx: number, my: number): ProcessedEvent | null {
    let currentY = view.y;
    for (const thread of threads) {
        const sourceH = (thread.maxSourceDepth + 1) * view.rowHeight;
        const mainH = (thread.maxMainDepth + 1) * view.rowHeight;
        if (my >= currentY + 20 && my <= currentY + 20 + sourceH) {
            const found = thread.sourceEvents.find(ev => isHit(ev, mx, my, currentY + 20));
            if (found) { return found; }
        }
        const mainOffsetY = currentY + 20 + sourceH + 10;
        if (my >= mainOffsetY && my <= mainOffsetY + mainH) {
            const found = thread.mainEvents.find(ev => isHit(ev, mx, my, mainOffsetY));
            if (found) { return found; }
        }
        currentY += 20 + sourceH + 10 + mainH + view.trackSpacing;
    }
    return null;
}

function updateTooltip(e: MouseEvent): void {
    if (contextMenu.style.display === 'block') {
        tooltip.style.display = 'none';
        return;
    }

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    if (mouseY < CONFIG.TIMELINE.HEIGHT) {
        tooltip.style.display = 'none';
        return;
    }

    const found = getEventAtPosition(mouseX, mouseY);

    if (found) {
        tooltip.style.display = 'block';
        tooltip.innerHTML = `<strong>${found.name}</strong><br/>${(found.dur / 1000).toFixed(3)} ms<br/><small>${found.detail}</small>`;

        const tooltipWidth = tooltip.offsetWidth || 200;
        const tooltipHeight = tooltip.offsetHeight || 60;

        let posX = e.clientX + 15;
        let posY = e.clientY + 15;

        if (posX + tooltipWidth > window.innerWidth) { posX = e.clientX - tooltipWidth - 15; }
        if (posY + tooltipHeight > window.innerHeight) { posY = e.clientY - tooltipHeight - 15; }

        tooltip.style.left = posX + 'px';
        tooltip.style.top = posY + 'px';
    } else {
        tooltip.style.display = 'none';
    }
}

function isHit(ev: ProcessedEvent, mx: number, my: number, offsetY: number): boolean {
    const x = (ev.start * view.scale) + view.x;
    const w = Math.max(1, ev.dur * view.scale);
    const y = offsetY + (ev.depth * view.rowHeight);
    return mx >= x && mx <= x + w && my >= y && my <= y + (view.rowHeight - 1);
}

document.getElementById('menu-open-file')?.addEventListener('click', () => {
    if (rightClickedEvent?.detail && vscode) {
        vscode.postMessage({ command: 'openFile', path: rightClickedEvent.detail });
    }
});

document.getElementById('menu-copy-path')?.addEventListener('click', () => {
    if (rightClickedEvent?.detail && vscode) {
        vscode.postMessage({ command: 'copyPath', path: rightClickedEvent.detail });
    }
});

window.addEventListener('resize', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    clampView();
    render();
});

window.addEventListener('message', event => {
    const message = event.data;
    if (message.command === 'update' && message.data) {
        preprocess(message.data);
        resetView();
    }
});

const globalData = (window as any).initialData;
if (globalData) {
    preprocess(globalData);
    resetView();
}