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
	events: ProcessedEvent[];
	maxDepth: number;
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

let threads: Thread[] = [];
let maxTraceTime = 0;
let totalContentHeight = 0;

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
	if (maxTraceTime <= 0) return;

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
	const threadMap: Record<string, Omit<ProcessedEvent, 'depth'>[]> = {};
	const openEvents: Record<string, TraceEvent[]> = {};

	maxTraceTime = 0;

	events.forEach(e => {
		if (e.tid === undefined) return;
		const tidStr = e.tid.toString();
		if (!threadMap[tidStr]) threadMap[tidStr] = [];

		if (e.ph === 'X') {
			const end = e.ts + (e.dur || 0);
			threadMap[tidStr].push({
				name: e.name,
				detail: e.args?.detail || "",
				start: e.ts,
				dur: e.dur || 0,
				end: end,
				tid: tidStr
			});
			if (end > maxTraceTime) maxTraceTime = end;
		}
		else if (e.ph === 'b') {
			const key = `${tidStr}-${e.name}`;
			if (!openEvents[key]) openEvents[key] = [];
			openEvents[key].push(e);
		}
		else if (e.ph === 'e') {
			const key = `${tidStr}-${e.name}`;
			const startEvent = openEvents[key]?.pop();
			if (startEvent) {
				const duration = e.ts - startEvent.ts;
				threadMap[tidStr].push({
					name: startEvent.name,
					detail: startEvent.args?.detail || "",
					start: startEvent.ts,
					dur: duration,
					end: e.ts,
					tid: tidStr
				});
				if (e.ts > maxTraceTime) maxTraceTime = e.ts;
			}
		}
	});

	threads = Object.keys(threadMap).map(tid => {
		const tEvents = (threadMap[tid] as ProcessedEvent[]).sort(
			(a, b) => a.start - b.start || b.dur - a.dur
		);

		const stack: ProcessedEvent[] = [];
		let maxDepth = 0;

		tEvents.forEach(ev => {
			while (stack.length > 0 && ev.start >= stack[stack.length - 1].end) {
				stack.pop();
			}
			ev.depth = stack.length;
			maxDepth = Math.max(maxDepth, ev.depth);
			stack.push(ev);
		});

		return { tid, events: tEvents, maxDepth };
	});

	updateTotalHeight();
}

function updateTotalHeight(): void {
	totalContentHeight = 0;
	threads.forEach(thread => {
		totalContentHeight += (thread.maxDepth + 1) * view.rowHeight + view.trackSpacing;
	});
}

function clampView(): void {
	const marginY = CONFIG.TIMELINE.HEIGHT + 10;
	const contentWidth = maxTraceTime * view.scale;
	const availableWidth = canvas.width;

	if (contentWidth > availableWidth - (CONFIG.VIEW.MARGIN_SIDE * 2)) {
		const minX = availableWidth - contentWidth - CONFIG.VIEW.MARGIN_SIDE;
		const maxX = CONFIG.VIEW.MARGIN_SIDE;
		if (view.x > maxX) view.x = maxX;
		if (view.x < minX) view.x = minX;
	} else {
		view.x = CONFIG.VIEW.MARGIN_SIDE;
	}

	const minY = canvas.height - totalContentHeight - 20;
	if (totalContentHeight > canvas.height - marginY) {
		if (view.y > marginY) view.y = marginY;
		if (view.y < minY) view.y = minY;
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
	if (!text) return "";
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
	if (targetTimeGap / pow > 5) step = 5 * pow;
	else if (targetTimeGap / pow > 2.5) step = 2.5 * pow;
	else if (targetTimeGap / pow > 2) step = 2 * pow;

	const startTime = (0 - view.x) / view.scale;
	const endTime = (canvas.width - view.x) / view.scale;
	const firstTick = Math.ceil(startTime / step) * step;

	const useMs = step >= 1000;

	for (let t = firstTick; t <= endTime; t += step) {
		const x = t * view.scale + view.x;
		if (x < 0 || x > canvas.width) continue;

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

function render(): void {
	canvas.width = getClientWidth();
	canvas.height = window.innerHeight;
	ctx.clearRect(0, 0, canvas.width, canvas.height);

	let currentY = view.y;

	threads.forEach((thread, index) => {
		const threadHeight = (thread.maxDepth + 1) * view.rowHeight + view.trackSpacing;

		if (currentY + threadHeight < CONFIG.TIMELINE.HEIGHT || currentY > canvas.height) {
			currentY += threadHeight;
			return;
		}

		if (index > 0) {
			ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
			ctx.beginPath();
			ctx.moveTo(0, currentY - view.trackSpacing / 2);
			ctx.lineTo(canvas.width, currentY - view.trackSpacing / 2);
			ctx.stroke();
		}

		thread.events.forEach(ev => {
			const x = (ev.start * view.scale) + view.x;
			const w = ev.dur * view.scale;
			const y = currentY + (ev.depth * view.rowHeight);

			if (x + w < 0 || x > canvas.width || y + view.rowHeight < CONFIG.TIMELINE.HEIGHT || y > canvas.height) return;

			const rectH = view.rowHeight - 1;
			const rectW = Math.max(0.5, w);

			ctx.fillStyle = getColor(ev.name);
			ctx.beginPath();
			ctx.roundRect(x, y, rectW, rectH, CONFIG.RENDERING.ROUNDING);
			ctx.fill();

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
		});

		currentY += threadHeight;
	});

	renderTimeline();
}

// --- Interactions ---

let isDragging = false;
let lastMouse = { x: 0, y: 0 };

canvas.addEventListener('mousedown', (e: MouseEvent) => {
	isDragging = true;
	lastMouse = { x: e.clientX, y: e.clientY };
	canvas.style.cursor = 'grabbing';
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

/**
 * Handle tooltip display and smart positioning
 */
function updateTooltip(e: MouseEvent): void {
	const rect = canvas.getBoundingClientRect();
	const mouseX = e.clientX - rect.left;
	const mouseY = e.clientY - rect.top;

	if (mouseY < CONFIG.TIMELINE.HEIGHT) {
		tooltip.style.display = 'none';
		return;
	}

	let found: ProcessedEvent | undefined = undefined;
	let currentY = view.y;

	for (const thread of threads) {
		const threadHeight = (thread.maxDepth + 1) * view.rowHeight;
		if (mouseY >= currentY && mouseY <= currentY + threadHeight) {
			found = thread.events.find(ev => {
				const x = (ev.start * view.scale) + view.x;
				const w = ev.dur * view.scale;
				const y = currentY + (ev.depth * view.rowHeight);
				const hitW = Math.max(1, w);
				return mouseX >= x && mouseX <= x + hitW &&
					mouseY >= y && mouseY <= y + (view.rowHeight - 1);
			});
		}
		if (found) break;
		currentY += (thread.maxDepth + 1) * view.rowHeight + view.trackSpacing;
	}

	if (found) {
		tooltip.style.display = 'block';
		tooltip.innerHTML = `<strong>${found.name}</strong><br/>${(found.dur / 1000).toFixed(3)} ms<br/><small>${found.detail}</small>`;

		const tooltipWidth = tooltip.offsetWidth || 200;
		const tooltipHeight = tooltip.offsetHeight || 60;

		let posX = e.clientX + 15;
		let posY = e.clientY + 15;

		if (posX + tooltipWidth > window.innerWidth) posX = e.clientX - tooltipWidth - 15;
		if (posY + tooltipHeight > window.innerHeight) posY = e.clientY - tooltipHeight - 15;

		tooltip.style.left = posX + 'px';
		tooltip.style.top = posY + 'px';
	} else {
		tooltip.style.display = 'none';
	}
}

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