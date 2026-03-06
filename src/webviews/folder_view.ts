interface FileStats {
	Path: string;
	TotalTime: number;
	SourceTime: number;
	CodeGenTime: number;
	OptimTime: number;
}

interface IncludeStats {
	Path: string;
	Time: number;
	Count: number;
	IncludedBy: string[];
}

interface CodeGenStats {
	Symbol: string;
	Time: number;
	Count: number;
}

interface CumulatedIncludeStats {
	Path: string;
	TotalTime: number;
	Count: number;
	IncludedBy: string[];
}

interface TraceResult {
	files: FileStats[];
	includes: IncludeStats[];
	codeGen: CodeGenStats[];
	cumulatedIncludes: CumulatedIncludeStats[];
}

let data: TraceResult;
let currentView: 'Files' | 'Includes' | 'IncludesCumulatedTime' = 'Files';
let currentList: any[] = [];
let expandedItems = new Set<number>();
let itemYPositions: number[] = [];

const tabDescriptions: Record<string, string> = {
	'Files': 'Translation units sorted by total compilation time — spot which files are the biggest bottlenecks in your build.',
	'Includes': 'Headers sorted by their own parse time — large headers that are inherently expensive to process.',
	'IncludesCumulatedTime': 'Headers sorted by their total cost across all files that include them. A small header included in 500 files can outweigh a large one included once. This list is a great starting point for defining the contents of a Precompiled Header (PCH).'
};

const canvas = document.getElementById('mainCanvas') as HTMLCanvasElement;
const overlay = document.getElementById('loadingOverlay') as HTMLElement;
const container = document.getElementById('canvasContainer') as HTMLElement;
const virtualHeight = document.getElementById('virtualHeight') as HTMLElement;
const ctx = canvas.getContext('2d')!;

const boxHeight = 42;
const boxPadding = 6;
const itemFullHeight = boxHeight + boxPadding;
const subItemHeight = 20;
const topOffset = 10;

function getItemHeight(index: number): number {
	const item = currentList[index];
	if (expandedItems.has(index) && item.IncludedBy?.length) {
		return itemFullHeight + item.IncludedBy.length * subItemHeight + 8;
	}
	return itemFullHeight;
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
	else if (currentView === 'IncludesCumulatedTime') { list = data.cumulatedIncludes; }

	if (!list || list.length === 0) { return; }

	currentList = list;
	expandedItems.clear();
	computeItemPositions();

	drawList();
}

function drawList(): void {
	if (!currentList.length) { return; }

	const maxTime = Math.max(...currentList.map(f => f.TotalTime || f.Time || 0));
	const maxCanvasWidth = canvas.width - 40;
	const scrollTop = container.scrollTop;

	ctx.clearRect(0, 0, canvas.width, canvas.height);

	for (let i = 0; i < currentList.length; i++) {
		const screenTop = itemYPositions[i] - scrollTop;
		const screenBottom = screenTop + getItemHeight(i);
		if (screenBottom < 0) { continue; }
		if (screenTop > canvas.height) { break; }

		const item = currentList[i];
		const itemTime = item.TotalTime || item.Time;

		let fileName = item.Path.split(/[\\/]/).pop() || item.Path;
		fileName = fileName.replace('.cpp.json', '.cpp').replace('.json', '');

		const boxWidth = Math.max((itemTime / maxTime) * (maxCanvasWidth - 100), 150);
		const isExpandable = currentView !== 'Files' && item.IncludedBy?.length > 0;
		const isExpanded = expandedItems.has(i);

		const expandedListHeight = isExpanded && item.IncludedBy?.length
			? item.IncludedBy.length * subItemHeight + 8
			: 0;
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
			const pct = item.SourceTime / item.TotalTime;
			const sourceW = pct * (boxWidth - 20);

			ctx.fillStyle = '#4a9e5c';
			roundRect(ctx, 20, barY, Math.max(sourceW, 4), barH, 3, true, false);

			ctx.font = '9px sans-serif';
			ctx.fillStyle = '#ffffff';
			ctx.fillText(`${Math.round(pct * 100)}% includes`, 24, barY + 9);
		} else {
			ctx.fillStyle = '#888888';
			ctx.font = '10px sans-serif';
			const arrow = isExpandable ? (isExpanded ? '▼ ' : '▶ ') : '';
			ctx.fillText(`${arrow}${item.Count} inclusion${item.Count > 1 ? 's' : ''}`, 20, screenTop + 34);
		}

		ctx.fillStyle = '#888888';
		ctx.font = '10px sans-serif';
		const timeStr = `${(itemTime / 1000).toFixed(1)} ms`;
		ctx.fillText(timeStr, 10 + boxWidth + 10, screenTop + 25);

		if (isExpanded && item.IncludedBy?.length) {
			const listTop = screenTop + boxHeight;
			ctx.font = '11px sans-serif';
			item.IncludedBy.forEach((srcPath: string, j: number) => {
				let srcName = srcPath.split(/[\\/]/).pop() || srcPath;
				srcName = srcName.replace('.cpp.json', '.cpp').replace('.json', '');
				const rowY = listTop + j * subItemHeight;
				ctx.fillStyle = j % 2 === 0 ? '#333333' : '#2d2d2d';
				ctx.fillRect(11, rowY, boxWidth - 2, subItemHeight);
				ctx.fillStyle = '#cccccc';
				ctx.fillText(srcName, 24, rowY + 14);
			});
		}
	}

}

canvas.addEventListener('mousemove', (e) => {
	const rect = canvas.getBoundingClientRect();
	const realY = e.clientY - rect.top + container.scrollTop;
	const index = findItemAtY(realY);

	if (index >= 0) {
		const item = currentList[index];
		// Check if hovering a sub-item row
		const itemTop = itemYPositions[index];
		const subOffset = realY - itemTop - itemFullHeight;
		if (expandedItems.has(index) && subOffset >= 0 && item.IncludedBy?.length) {
			const subIndex = Math.floor(subOffset / subItemHeight);
			if (subIndex < item.IncludedBy.length) {
				canvas.title = item.IncludedBy[subIndex];
			}
		} else {
			canvas.title = item.Path;
		}
		canvas.style.cursor = currentView !== 'Files' && item.IncludedBy?.length ? 'pointer' : 'default';
	} else {
		canvas.title = '';
		canvas.style.cursor = 'default';
	}
});

canvas.addEventListener('click', (e) => {
	if (currentView === 'Files') { return; }

	const rect = canvas.getBoundingClientRect();
	const realY = e.clientY - rect.top + container.scrollTop;
	const index = findItemAtY(realY);

	if (index < 0) { return; }
	const item = currentList[index];
	if (!item.IncludedBy?.length) { return; }

	// Only toggle if click is on the base box, not on a sub-item row
	const itemTop = itemYPositions[index];
	if (realY > itemTop + itemFullHeight) { return; }

	if (expandedItems.has(index)) {
		expandedItems.delete(index);
	} else {
		expandedItems.add(index);
	}
	computeItemPositions();
	requestAnimationFrame(drawList);
});

// --- HELPERS ---



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
