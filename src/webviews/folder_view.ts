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
}

interface TraceResult {
	files: FileStats[];
	includes: IncludeStats[];
	codeGen: CodeGenStats[];
	cumulatedIncludes: CumulatedIncludeStats[];
}

let data: TraceResult;
let currentView: 'Files' | 'Includes' | 'IncludesCumulatedTime' = 'Files';

function initTabs(): void {
	const container = document.getElementById('canvasContainer')!;
	const tabs = document.querySelectorAll<HTMLButtonElement>('.tab-btn');

	tabs.forEach(btn => {
		btn.addEventListener('click', () => {
			const target = btn.dataset.target as any;
			if (!target) { return; }

			tabs.forEach(t => t.classList.remove('active'));
			btn.classList.add('active');

			currentView = target;
			render();
		});
	});

	container.addEventListener('scroll', () => requestAnimationFrame(render));

	const resizeObserver = new ResizeObserver(() => {
		requestAnimationFrame(render);
	});
	resizeObserver.observe(container);

	render();
}

function render(): void {

	const canvas = document.getElementById('mainCanvas') as HTMLCanvasElement;
	const overlay = document.getElementById('loadingOverlay') as HTMLElement;

	if (!data) {
		canvas.style.display = 'none';
		overlay.style.display = 'block';
		return;
	}

	canvas.style.display = 'block';
	overlay.style.display = 'none';

	const container = document.getElementById('canvasContainer')!;
	const virtualHeight = document.getElementById('virtualHeight')!;
	const ctx = canvas.getContext('2d')!;

	const boxHeight = 42;
	const boxPadding = 6;
	const itemFullHeight = boxHeight + boxPadding;
	const topOffset = 60;

	canvas.width = container.clientWidth;
	canvas.height = container.clientHeight;

	let list: any[] = [];
	if (currentView === 'Files') { list = data.files; }
	else if (currentView === 'Includes') { list = data.includes; }
	else if (currentView === 'IncludesCumulatedTime') { list = data.cumulatedIncludes; }

	if (!list || list.length === 0) { return; }

	const totalHeight = list.length * itemFullHeight + topOffset + 50;
	virtualHeight.style.height = `${totalHeight}px`;

	const scrollTop = container.scrollTop;
	const startIndex = Math.floor(Math.max(0, scrollTop - topOffset) / itemFullHeight);
	const endIndex = Math.min(list.length, Math.ceil((scrollTop + canvas.height) / itemFullHeight));

	const maxTime = Math.max(...list.map(f => f.TotalTime || f.Time || 0));
	const maxCanvasWidth = canvas.width - 40;

	ctx.clearRect(0, 0, canvas.width, canvas.height);

	if (currentView === 'Files') { drawLegend(ctx, 10, 25); }

	for (let i = startIndex; i < endIndex; i++) {
		const item = list[i];
		const itemTime = item.TotalTime || item.Time;

		const startY = i * itemFullHeight + topOffset - scrollTop;

		let fileName = item.Path.split(/[\\/]/).pop() || item.Path;
		fileName = fileName.replace('.cpp.json', '.cpp').replace('.json', '');

		const boxWidth = Math.max((itemTime / maxTime) * (maxCanvasWidth - 100), 150);

		ctx.fillStyle = '#2d2d2d';
		ctx.strokeStyle = '#454545';
		roundRect(ctx, 10, startY, boxWidth, boxHeight, 4, true, true);

		ctx.fillStyle = '#e0e0e0';
		ctx.font = '13px sans-serif';
		ctx.fillText(fileName, 20, startY + 18);

		if (currentView === 'Files') {
			const barY = startY + 26;
			const barH = 4;
			const sourceW = (item.SourceTime / item.TotalTime) * boxWidth;
			const codeGenW = (item.CodeGenTime / item.TotalTime) * boxWidth;
			const optimW = (item.OptimTime / item.TotalTime) * boxWidth;

			ctx.fillStyle = getColor("Source");
			ctx.fillRect(20, barY, sourceW, barH);
			ctx.fillStyle = getColor("InstantiateFunction");
			ctx.fillRect(20, barY + barH, codeGenW, barH);
			ctx.fillStyle = getColor("OptModule");
			ctx.fillRect(20, barY + (barH * 2), optimW, barH);
		}

		ctx.fillStyle = '#888888';
		ctx.font = '10px sans-serif';
		const timeStr = `${(itemTime / 1000).toFixed(1)} ms`;
		ctx.fillText(timeStr, 10 + boxWidth + 10, startY + 25);
	}

	canvas.onmousemove = (e) => {
		const rect = canvas.getBoundingClientRect();
		const mouseY = e.clientY - rect.top;
		const realY = mouseY + scrollTop - topOffset;
		const index = Math.floor(realY / itemFullHeight);

		if (index >= 0 && index < list.length && realY >= 0) {
			canvas.title = list[index].Path;
			canvas.style.cursor = 'pointer';
		} else {
			canvas.style.cursor = 'default';
		}
	};
}

// --- HELPERS ---

function getColor(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = name.charCodeAt(i) + ((hash << 5) - hash);
	}
	return `hsl(${Math.abs(hash % 360)}, 50%, 45%)`;
}

function drawLegend(ctx: CanvasRenderingContext2D, x: number, y: number) {
	const categories = [
		{ label: 'Source', color: getColor("Source") },
		{ label: 'CodeGen', color: getColor("InstantiateFunction") },
		{ label: 'Opti', color: getColor("OptModule") }
	];
	ctx.font = '11px sans-serif';
	categories.forEach((cat, i) => {
		ctx.fillStyle = cat.color;
		ctx.fillRect(x + (i * 100), y - 10, 10, 10);
		ctx.fillStyle = '#cccccc';
		ctx.fillText(cat.label, x + 15 + (i * 100), y);
	});
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
