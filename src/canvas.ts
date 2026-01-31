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

declare function acquireVsCodeApi(): any;
const vscode = (window as any).acquireVsCodeApi ? acquireVsCodeApi() : null;

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const tooltip = document.getElementById('tooltip') as HTMLDivElement;
const resetBtn = document.getElementById('resetBtn') as HTMLButtonElement;

let threads: Thread[] = [];
let maxTraceTime = 0;
let totalContentHeight = 0;

let view: ViewState = {
	x: 100,
	y: 50,
	scale: 0.1,
	rowHeight: 24,
	trackSpacing: 40
};

// --- Logique de calcul ---

function preprocess(data: { traceEvents: TraceEvent[] }): void {
	const events = data.traceEvents || [];
	const threadMap: Record<string, Omit<ProcessedEvent, 'depth'>[]> = {};
	const openEvents: Record<string, TraceEvent[]> = {};

	maxTraceTime = 0;

	// 1. Unification (gestion des phases X, b, e)
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

	// 2. Hiérarchie (calcul des profondeurs / stack)
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

	// Calcul de la hauteur totale pour le clamping vertical
	updateTotalHeight();
}

function updateTotalHeight(): void {
	totalContentHeight = 0;
	threads.forEach(thread => {
		totalContentHeight += (thread.maxDepth + 2) * view.rowHeight + view.trackSpacing;
	});
}

/**
 * Empêche la vue de sortir des limites des données
 */
function clampView(): void {
	const marginX = 100;
	const marginY = 50;
	const contentWidth = maxTraceTime * view.scale;

	// Clamp Horizontal
	if (view.x > marginX) view.x = marginX;
	if (contentWidth > canvas.width - marginX * 2) {
		if (view.x + contentWidth < canvas.width - marginX) {
			view.x = canvas.width - contentWidth - marginX;
		}
	} else {
		view.x = marginX; // Si tout tient dans l'écran, on reste à gauche
	}

	// Clamp Vertical
	if (view.y > marginY) view.y = marginY;
	if (totalContentHeight > canvas.height - marginY * 2) {
		if (view.y + totalContentHeight < canvas.height - marginY) {
			view.y = canvas.height - totalContentHeight - marginY;
		}
	} else {
		view.y = marginY;
	}
}

// --- Rendu ---

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

function render(): void {
	canvas.width = window.innerWidth;
	canvas.height = window.innerHeight;
	ctx.clearRect(0, 0, canvas.width, canvas.height);

	let currentY = view.y;

	threads.forEach(thread => {
		// Titre du Thread
		ctx.fillStyle = "#aaa";
		ctx.font = "bold 12px sans-serif";
		ctx.fillText(`Thread ${thread.tid}`, 10, currentY - 10);

		thread.events.forEach(ev => {
			const x = (ev.start * view.scale) + view.x;
			const w = ev.dur * view.scale;
			const y = currentY + (ev.depth * view.rowHeight);

			// Culling (ne pas dessiner ce qui est hors écran)
			if (x + w < 0 || x > canvas.width) return;

			// Dessin de la box
			ctx.fillStyle = getColor(ev.name);
			ctx.fillRect(x, y, Math.max(0.5, w), view.rowHeight - 1);

			// Dessin du texte (si la box est assez large)
			if (w > 15) {
				ctx.save();
				ctx.beginPath();
				ctx.rect(x, y, w, view.rowHeight);
				ctx.clip();

				const textX = Math.max(x, 0) + 4;
				ctx.font = "bold 11px sans-serif";

				// On vérifie si on a la place d'écrire au moins le début du nom
				if (textX < x + w - 5) {
					// Nom principal
					ctx.fillStyle = "white";
					ctx.fillText(ev.name, textX, y + 16);

					// Détail (le short path)
					if (ev.detail) {
						const nameWidth = ctx.measureText(ev.name).width;
						ctx.fillStyle = "rgba(255, 255, 255, 0.7)"; // Un peu plus discret
						ctx.font = "10px sans-serif";
						// On affiche le détail décalé après le nom
						ctx.fillText(shortenPath(ev.detail), textX + nameWidth + 8, y + 16);
					}
				}
				ctx.restore();
			}
		});

		// Décalage pour le prochain thread
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
		clampView();
		render();
	} else {
		updateTooltip(e);
	}
});

window.addEventListener('mouseup', () => isDragging = false);

canvas.addEventListener('wheel', (e: WheelEvent) => {
	e.preventDefault();
	const zoomIntensity = 0.15;
	const delta = e.deltaY > 0 ? (1 - zoomIntensity) : (1 + zoomIntensity);

	const mouseWorldX = (e.clientX - view.x) / view.scale;

	// Limitation du dezoom : on ne peut pas dézoomer plus que la largeur de l'écran
	const minScale = (canvas.width - 200) / maxTraceTime;
	let newScale = view.scale * delta;
	newScale = Math.max(minScale, Math.min(newScale, 20));

	view.scale = newScale;
	view.x = e.clientX - mouseWorldX * view.scale;

	clampView();
	render();
}, { passive: false });

function updateTooltip(e: MouseEvent): void {
	let found: ProcessedEvent | undefined = undefined;
	let currentY = view.y;

	for (const thread of threads) {
		const threadBottom = currentY + (thread.maxDepth + 1) * view.rowHeight;
		if (e.clientY >= currentY && e.clientY <= threadBottom) {
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
		tooltip.innerHTML = `<strong>${found.name}</strong><br/>${(found.dur / 1000).toFixed(3)} ms<br/><small>${found.detail}</small>`;
	} else {
		tooltip.style.display = 'none';
	}
}

resetBtn.addEventListener('click', () => {
	view.x = 100; view.y = 50;
	view.scale = (canvas.width - 200) / maxTraceTime;
	clampView();
	render();
});

window.addEventListener('resize', () => {
	render();
	clampView();
});

window.addEventListener('message', event => {
	const message = event.data;
	if (message.command === 'update' && message.data) {
		preprocess(message.data);
		render();
	}
});

const globalData = (window as any).initialData;
if (globalData) {
	preprocess(globalData);
	render();
}