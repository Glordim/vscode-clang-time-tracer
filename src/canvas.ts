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

// --- Initialisation ---

// Déclaration pour VS Code API
declare function acquireVsCodeApi(): any;
const vscode = acquireVsCodeApi();

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const tooltip = document.getElementById('tooltip') as HTMLDivElement;
const resetBtn = document.getElementById('resetBtn') as HTMLButtonElement;

let threads: Thread[] = [];

let view: ViewState = {
	x: 100,
	y: 50,
	scale: 0.1,
	rowHeight: 24,
	trackSpacing: 40
};

// --- Logique ---

function preprocess(data: { traceEvents: TraceEvent[] }): void {

	console.log("Structure du JSON reçu :", Object.keys(data));

	const events = data.traceEvents || [];
	const threadMap: Record<string, Omit<ProcessedEvent, 'depth'>[]> = {};
	const openEvents: Record<string, TraceEvent[]> = {};

	// 1. Première passe : Unification
	events.forEach(e => {
		if (e.tid === undefined) return;
		const tidStr = e.tid.toString();
		if (!threadMap[tidStr]) threadMap[tidStr] = [];

		if (e.ph === 'X') {
			threadMap[tidStr].push({
				name: e.name,
				detail: e.args?.detail || "",
				start: e.ts,
				dur: e.dur || 0,
				end: e.ts + (e.dur || 0),
				tid: tidStr
			});
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
			}
		}
	});

	// 2. Deuxième passe : Hiérarchie
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
}

function shortenPath(text: string): string {
	if (!text) return "";
	const isPath = /[\\\/]/.test(text);
	if (isPath) {
		const parts = text.split(/[\\\/]/);
		let lastPart = parts[parts.length - 1];
		if (!lastPart && parts.length > 1) {
			lastPart = parts[parts.length - 2];
		}
		return lastPart;
	}
	return text;
}

function getColor(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = name.charCodeAt(i) + ((hash << 5) - hash);
	}
	return `hsl(${Math.abs(hash % 360)}, 50%, 45%)`;
}

function render(): void {
	canvas.width = window.innerWidth;
	canvas.height = window.innerHeight;
	ctx.clearRect(0, 0, canvas.width, canvas.height);

	let currentY = view.y;

	threads.forEach(thread => {
		ctx.fillStyle = "#aaa";
		ctx.font = "bold 12px sans-serif";
		ctx.fillText(`Thread ${thread.tid}`, 10, currentY - 10);

		thread.events.forEach(ev => {
			const x = (ev.start * view.scale) + view.x;
			const w = ev.dur * view.scale;
			const y = currentY + (ev.depth * view.rowHeight);

			if (x + w < 0 || x > canvas.width) return;

			ctx.fillStyle = getColor(ev.name);
			ctx.fillRect(x, y, Math.max(0.5, w), view.rowHeight - 1);

			if (w > 10) {
				ctx.save();
				ctx.beginPath();
				ctx.rect(x, y, w, view.rowHeight);
				ctx.clip();

				ctx.font = "bold 11px sans-serif";
				const textX = Math.max(x, 0) + 4;

				if (textX < x + w - 5) {
					ctx.fillStyle = "white";
					ctx.fillText(ev.name, textX, y + 16);

					if (ev.detail) {
						const nameWidth = ctx.measureText(ev.name).width;
						ctx.fillStyle = "#e0e0e0";
						ctx.font = "10px sans-serif";
						ctx.fillText(shortenPath(ev.detail), textX + nameWidth + 8, y + 16);
					}
				}
				ctx.restore();
			}
		});

		currentY += (thread.maxDepth + 2) * view.rowHeight + view.trackSpacing;
	});
}

// --- Interactions ---

let isDragging = false;
let lastMouse = { x: 0, y: 0 };

canvas.addEventListener('mousedown', (e: MouseEvent) => {
	isDragging = true;
	lastMouse = { x: e.clientX, y: e.clientY };
});

window.addEventListener('mousemove', (e: MouseEvent) => {
	if (isDragging) {
		view.x += e.clientX - lastMouse.x;
		view.y += e.clientY - lastMouse.y;
		lastMouse = { x: e.clientX, y: e.clientY };
		render();
	} else {
		updateTooltip(e);
	}
});

window.addEventListener('mouseup', () => isDragging = false);

canvas.addEventListener('wheel', (e: WheelEvent) => {
	e.preventDefault();
	const zoomIntensity = 0.1;
	const delta = e.deltaY > 0 ? (1 - zoomIntensity) : (1 + zoomIntensity);

	const mouseWorldX = (e.clientX - view.x) / view.scale;
	view.scale *= delta;
	view.scale = Math.max(0.00001, Math.min(view.scale, 10));
	view.x = e.clientX - mouseWorldX * view.scale;

	render();
}, { passive: false });

function updateTooltip(e: MouseEvent): void {
	let found: ProcessedEvent | undefined = undefined;
	let currentY = view.y;

	for (const thread of threads) {
		const threadTop = currentY;
		const threadBottom = currentY + (thread.maxDepth + 1) * view.rowHeight;

		if (e.clientY >= threadTop && e.clientY <= threadBottom) {
			found = thread.events.find(ev => {
				const x = (ev.start * view.scale) + view.x;
				const w = ev.dur * view.scale;
				const y = currentY + (ev.depth * view.rowHeight);
				return e.clientX >= x && e.clientX <= x + w &&
					e.clientY >= y && e.clientY <= y + view.rowHeight;
			});
		}
		if (found) break;
		currentY += (thread.maxDepth + 2) * view.rowHeight + view.trackSpacing;
	}

	if (found) {
		tooltip.style.display = 'block';
		tooltip.style.left = (e.clientX + 15) + 'px';
		tooltip.style.top = (e.clientY + 15) + 'px';
		tooltip.innerHTML = `<strong>${found.name}</strong><br/>${(found.dur / 1000).toFixed(2)} ms<br/><small>${found.detail}</small>`;
	} else {
		tooltip.style.display = 'none';
	}
}

resetBtn.addEventListener('click', () => {
	view.x = 100; view.y = 50; view.scale = 0.1;
	render();
});

window.addEventListener('resize', render);

// Écouter les données envoyées par l'extension
window.addEventListener('message', event => {
	const message = event.data;
	switch (message.command) {
		case 'update': // Cas où l'extension envoie une nouvelle trace
			if (message.data) {
				preprocess(message.data);
				render();
			}
			break;
	}
});

// Vérifier si des données ont été injectées directement dans le HTML au chargement
// (Si tu as utilisé la technique window.initialData du message précédent)
const globalData = (window as any).initialData;
if (globalData) {
	preprocess(globalData);
	render();
}