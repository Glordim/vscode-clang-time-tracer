interface FileStats {
	tracePath: string;
	sourcePath: string;
	totalTime: number;
	sourceTime: number;
	templateTime: number;
	optimTime: number;
}

interface IncludeStats {
	path: string;
	maxTime: number;
	count: number;
	includedBy: string[];
}

interface CumulatedIncludeStats {
	path: string;
	totalTime: number;
	count: number;
	includedBy: string[];
}

interface TraceResult {
	files: FileStats[];
	includes: IncludeStats[];
	cumulatedIncludes: CumulatedIncludeStats[];
}

let data: TraceResult;
let currentView: 'Files' | 'Includes' | 'CumulatedIncludes' = 'Files';
let currentList: any[] = [];
let expandedItems = new Set<number>();
let itemYPositions: number[] = [];
let selectedIndex: number | null = null;

const ANIM_DURATION = 180;
const animatingItems = new Map<number, { startTime: number; expanding: boolean }>();
let animFrameId: number | null = null;

const tabDescriptions: Record<string, string> = {
	'Files': 'Translation units sorted by total compilation time — spot which files are the biggest bottlenecks in your build.',
	'Includes': 'Headers sorted by their own parse time — large headers that are inherently expensive to process.',
	'CumulatedIncludes': 'Headers sorted by their total cost across all files that include them. A small header included in 500 files can outweigh a large one included once. This list is a great starting point for defining the contents of a Precompiled Header (PCH).'
};

const canvas = document.getElementById('mainCanvas') as HTMLCanvasElement;
const overlay = document.getElementById('loadingOverlay') as HTMLElement;
const container = document.getElementById('canvasContainer') as HTMLElement;
const virtualHeight = document.getElementById('virtualHeight') as HTMLElement;
const contextMenu = document.getElementById('context-menu') as HTMLDivElement;
const ctx = canvas.getContext('2d')!;

let rightClickedPath: string | null = null;
let rightClickedTracePath: string | null = null;

const boxHeight = 42;
const boxPadding = 6;
const itemFullHeight = boxHeight + boxPadding;
const subItemHeight = 20;
const topOffset = 10;

function getItemHeight(index: number): number {
	const item = currentList[index];
	if (!item.includedBy?.length) { return itemFullHeight; }
	const p = getExpandProgress(index);
	if (p <= 0) { return itemFullHeight; }
	if (p >= 1) { return itemFullHeight + item.includedBy.length * subItemHeight + 8; }
	return itemFullHeight + Math.round(p * (item.includedBy.length * subItemHeight + 8));
}

function computeItemPositions(): void {
	itemYPositions = [];
	let y = topOffset;
	for (let i = 0; i < currentList.length; i++) {
		itemYPositions.push(y);
		y += getItemHeight(i);
	}
	virtualHeight.style.height = `${y + 50}px`;
}

function findItemAtY(y: number): number {
	for (let i = 0; i < itemYPositions.length; i++) {
		if (y >= itemYPositions[i] && y < itemYPositions[i] + getItemHeight(i)) {
			return i;
		}
	}
	return -1;
}

function initTabs(): void {
	const tabs = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
	const descText = document.getElementById('desc-text') as HTMLElement;

	function updateDescription(view: string) {
		descText.textContent = tabDescriptions[view] ?? '';
	}

	tabs.forEach(btn => {
		btn.addEventListener('click', () => {
			const target = btn.dataset.target as any;
			if (!target) { return; }

			tabs.forEach(t => t.classList.remove('active'));
			btn.classList.add('active');

			currentView = target;
			updateDescription(target);
			render();
		});
	});

	container.addEventListener('scroll', () => requestAnimationFrame(drawList));

	const resizeObserver = new ResizeObserver(() => {
		canvas.width = container.clientWidth;
		canvas.height = container.clientHeight;
		requestAnimationFrame(drawList);
	});
	resizeObserver.observe(container);

	updateDescription(currentView);
	render();
}

function render(): void {

	if (!data) {
		canvas.style.display = 'none';
		overlay.style.display = 'block';
		return;
	}

	canvas.style.display = 'block';
	overlay.style.display = 'none';

	canvas.width = container.clientWidth;
	canvas.height = container.clientHeight;

	let list: any[] = [];
	if (currentView === 'Files') { list = data.files; }
	else if (currentView === 'Includes') { list = data.includes; }
	else if (currentView === 'CumulatedIncludes') { list = data.cumulatedIncludes; }

	if (!list || list.length === 0) { return; }

	currentList = list;
	expandedItems.clear();
	animatingItems.clear();
	if (animFrameId !== null) { cancelAnimationFrame(animFrameId); animFrameId = null; }
	selectedIndex = null;
	computeItemPositions();

	drawList();
}

function drawList(): void {
	if (!currentList.length) { return; }

	const maxTime = Math.max(...currentList.map(f => f.totalTime || f.maxTime || 0));
	const maxCanvasWidth = canvas.width - 40;
	const scrollTop = container.scrollTop;

	ctx.clearRect(0, 0, canvas.width, canvas.height);

	for (let i = 0; i < currentList.length; i++) {
		const screenTop = itemYPositions[i] - scrollTop;
		const screenBottom = screenTop + getItemHeight(i);
		if (screenBottom < 0) { continue; }
		if (screenTop > canvas.height) { break; }

		const item = currentList[i];
		const itemTime = item.totalTime || item.maxTime;

		const displayPath: string = item.sourcePath ?? item.path;
		const fileName = displayPath.split(/[\\/]/).pop() || displayPath;

		const boxWidth = Math.max((itemTime / maxTime) * (maxCanvasWidth - 100), 150);
		const isExpandable = currentView !== 'Files' && item.includedBy?.length > 0;
		const expandProgress = getExpandProgress(i);
		const maxExpandHeight = item.includedBy?.length ? item.includedBy.length * subItemHeight + 8 : 0;
		const expandedListHeight = Math.round(expandProgress * maxExpandHeight);
		const totalBoxHeight = boxHeight + expandedListHeight;

		ctx.fillStyle = '#2d2d2d';
		ctx.strokeStyle = '#454545';
		roundRect(ctx, 10, screenTop, boxWidth, totalBoxHeight, 4, true, true);

		ctx.fillStyle = '#e0e0e0';
		ctx.font = '13px sans-serif';
		ctx.fillText(fileName, 20, screenTop + 18);

		if (currentView === 'Files') {
			const barY = screenTop + 24;
			const barH = 12;
			const pct = item.sourceTime / item.totalTime;
			const sourceW = pct * (boxWidth - 20);

			ctx.fillStyle = '#4a9e5c';
			roundRect(ctx, 20, barY, Math.max(sourceW, 4), barH, 3, true, false);

			ctx.font = '9px sans-serif';
			ctx.fillStyle = '#dddddd';
			ctx.fillText(`${Math.round(pct * 100)}% includes`, 24, barY + 9);
		} else {
			ctx.fillStyle = '#888888';
			ctx.font = '10px sans-serif';
			const arrow = isExpandable ? (expandProgress > 0.5 ? '▼ ' : '▶ ') : '';
			ctx.fillText(`${arrow}${item.count} inclusion${item.count > 1 ? 's' : ''}`, 20, screenTop + 34);
		}

		ctx.fillStyle = '#888888';
		ctx.font = '10px sans-serif';
		const timeStr = `${(itemTime / 1000).toFixed(1)} ms`;
		ctx.fillText(timeStr, 10 + boxWidth + 10, screenTop + 25);

		if (expandProgress > 0 && item.includedBy?.length) {
			const listTop = screenTop + boxHeight;
			ctx.save();
			ctx.beginPath();
			ctx.rect(10, listTop, boxWidth, expandedListHeight);
			ctx.clip();
			ctx.font = '11px sans-serif';
			item.includedBy.forEach((srcPath: string, j: number) => {
				const srcName = srcPath.split(/[\\/]/).pop() || srcPath;
				const rowY = listTop + j * subItemHeight;
				ctx.fillStyle = j % 2 === 0 ? '#333333' : '#2d2d2d';
				ctx.fillRect(11, rowY, boxWidth - 2, subItemHeight);
				ctx.fillStyle = '#cccccc';
				ctx.fillText(srcName, 24, rowY + 14);
			});
			ctx.restore();
		}

		if (selectedIndex === i) {
			ctx.strokeStyle = 'white';
			ctx.lineWidth = 2;
			roundRect(ctx, 10, screenTop, boxWidth, totalBoxHeight, 4, false, true);
			ctx.lineWidth = 1;
			ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
			roundRect(ctx, 10, screenTop, boxWidth, totalBoxHeight, 4, true, false);
		}
	}

}

canvas.addEventListener('mousemove', (e) => {
	const rect = canvas.getBoundingClientRect();
	const mouseX = e.clientX - rect.left;
	const realY = e.clientY - rect.top + container.scrollTop;
	const index = findItemAtY(realY);

	if (index >= 0) {
		const item = currentList[index];
		const itemTime = item.totalTime || item.maxTime;
		const maxTime = Math.max(...currentList.map((f: any) => f.totalTime || f.maxTime || 0));
		const boxWidth = Math.max((itemTime / maxTime) * (canvas.width - 40 - 100), 150);

		if (mouseX >= 10 && mouseX <= 10 + boxWidth) {
			const itemTop = itemYPositions[index];
			const subOffset = realY - itemTop - itemFullHeight;
			if (expandedItems.has(index) && subOffset >= 0 && item.includedBy?.length) {
				const subIndex = Math.floor(subOffset / subItemHeight);
				if (subIndex < item.includedBy.length) {
					canvas.title = item.includedBy[subIndex];
				}
			} else {
				canvas.title = item.sourcePath ?? item.path;
			}
			canvas.style.cursor = 'pointer';
			return;
		}
	}

	canvas.title = '';
	canvas.style.cursor = 'default';
});

canvas.addEventListener('click', (e) => {
	const rect = canvas.getBoundingClientRect();
	const mouseX = e.clientX - rect.left;
	const realY = e.clientY - rect.top + container.scrollTop;
	const index = findItemAtY(realY);

	if (index < 0) {
		selectedIndex = null;
		requestAnimationFrame(drawList);
		return;
	}

	const item = currentList[index];
	const itemTime = item.totalTime || item.maxTime;
	const maxTime = Math.max(...currentList.map((f: any) => f.totalTime || f.maxTime || 0));
	const boxWidth = Math.max((itemTime / maxTime) * (canvas.width - 40 - 100), 150);

	if (mouseX < 10 || mouseX > 10 + boxWidth) {
		selectedIndex = null;
		requestAnimationFrame(drawList);
		return;
	}

	selectedIndex = index;

	// Expand/collapse: only on the arrow glyph bounding box (drawn at x=20, y=itemTop+34, ~14px wide, 10px tall)
	if (currentView !== 'Files' && item.includedBy?.length) {
		const relY = realY - itemYPositions[index];
		if (relY >= 24 && relY <= 38 && mouseX >= 18 && mouseX <= 34) {
			toggleExpand(index);
			return;
		}
	}

	requestAnimationFrame(drawList);
});

canvas.addEventListener('dblclick', (e) => {
	const rect = canvas.getBoundingClientRect();
	const mouseX = e.clientX - rect.left;
	const realY = e.clientY - rect.top + container.scrollTop;
	const index = findItemAtY(realY);

	if (index < 0) { return; }

	const item = currentList[index];
	const itemTime = item.totalTime || item.maxTime;
	const maxTime = Math.max(...currentList.map((f: any) => f.totalTime || f.maxTime || 0));
	const boxWidth = Math.max((itemTime / maxTime) * (canvas.width - 40 - 100), 150);

	if (mouseX < 10 || mouseX > 10 + boxWidth) { return; }

	if (currentView !== 'Files') {
		if (item.includedBy?.length) {
			toggleExpand(index);
			selectedIndex = index;
		}
		return;
	}

	if (vscode) {
		selectedIndex = index;
		requestAnimationFrame(drawList);
		vscode.postMessage({ command: 'openTrace', path: item.tracePath });
	}
});

canvas.addEventListener('contextmenu', (e) => {
	e.preventDefault();

	if (currentView !== 'Files') {
		contextMenu.style.display = 'none';
		return;
	}

	const rect = canvas.getBoundingClientRect();
	const mouseX = e.clientX - rect.left;
	const realY = e.clientY - rect.top + container.scrollTop;
	const index = findItemAtY(realY);

	if (index >= 0) {
		const item = currentList[index];
		const itemTime = item.totalTime || item.maxTime;
		const maxTime = Math.max(...currentList.map((f: any) => f.totalTime || f.maxTime || 0));
		const boxWidth = Math.max((itemTime / maxTime) * (canvas.width - 40 - 100), 150);

		if (mouseX >= 10 && mouseX <= 10 + boxWidth) {
			rightClickedPath = item.sourcePath;
			rightClickedTracePath = item.tracePath;
			selectedIndex = index;
			requestAnimationFrame(drawList);
			contextMenu.style.display = 'block';
			contextMenu.style.left = `${e.clientX}px`;
			contextMenu.style.top = `${e.clientY}px`;
			return;
		}
	}

	contextMenu.style.display = 'none';
});

window.addEventListener('click', () => {
	contextMenu.style.display = 'none';
});

document.getElementById('menu-open-file')?.addEventListener('click', () => {
	if (rightClickedPath && vscode) {
		vscode.postMessage({ command: 'openFile', path: rightClickedPath });
	}
});

document.getElementById('menu-open-trace')?.addEventListener('click', () => {
	if (rightClickedTracePath && vscode) {
		vscode.postMessage({ command: 'openTrace', path: rightClickedTracePath });
	}
});

document.getElementById('menu-copy-path')?.addEventListener('click', () => {
	if (rightClickedPath && vscode) {
		vscode.postMessage({ command: 'copyPath', path: rightClickedPath });
	}
});

// --- HELPERS ---

function easeOut(t: number): number {
	return 1 - (1 - t) * (1 - t);
}

function easeOutInverse(p: number): number {
	return 1 - Math.sqrt(Math.max(0, 1 - p));
}

function getExpandProgress(index: number): number {
	const anim = animatingItems.get(index);
	if (anim) {
		const t = Math.min((performance.now() - anim.startTime) / ANIM_DURATION, 1);
		return anim.expanding ? easeOut(t) : 1 - easeOut(t);
	}
	return expandedItems.has(index) ? 1 : 0;
}

function toggleExpand(index: number): void {
	const item = currentList[index];
	if (!item.includedBy?.length) { return; }

	const expanding = !expandedItems.has(index);
	const currentProgress = getExpandProgress(index);
	if (expanding) { expandedItems.add(index); }

	const startProgress = expanding ? currentProgress : (1 - currentProgress);
	const tOffset = easeOutInverse(startProgress) * ANIM_DURATION;
	animatingItems.set(index, { startTime: performance.now() - tOffset, expanding });

	if (!animFrameId) {
		animFrameId = requestAnimationFrame(animateFrame);
	}
}

function animateFrame(): void {
	const now = performance.now();
	let anyActive = false;
	for (const [index, anim] of animatingItems) {
		if (now - anim.startTime >= ANIM_DURATION) {
			animatingItems.delete(index);
			if (!anim.expanding) { expandedItems.delete(index); }
		} else {
			anyActive = true;
		}
	}
	computeItemPositions();
	drawList();
	animFrameId = anyActive ? requestAnimationFrame(animateFrame) : null;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number, fill: boolean, stroke: boolean) {
	ctx.beginPath();
	ctx.roundRect(x, y, width, height, radius);
	if (fill) { ctx.fill(); }
	if (stroke) { ctx.stroke(); }
}

initTabs();

const vscode = typeof (window as any).acquireVsCodeApi === 'function' ? (window as any).acquireVsCodeApi() : null;
window.addEventListener('message', event => {
	const message = event.data;

	switch (message.command) {
		case 'initData':
			data = message.payload;
			render();
			break;
	}
});
vscode.postMessage({ command: 'webviewReady' });
