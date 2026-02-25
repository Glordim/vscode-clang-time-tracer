const data = (window as any).traceData;

function initTabs(): void {
	const tabs = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
	const panes = document.querySelectorAll<HTMLDivElement>('.tab-pane');

	tabs.forEach(btn => {
		btn.addEventListener('click', () => {
			const target = btn.dataset.target;
			if (!target) { return; }

			tabs.forEach(t => t.classList.remove('active'));
			btn.classList.add('active');

			panes.forEach(pane => {
				pane.style.display = pane.id === target ? 'block' : 'none';
			});

			handleRouting(target);
		});
	});

	handleRouting('Files');
}

function handleRouting(target: string): void {
	switch (target) {
		case 'Files':
			renderFilesView(data);
			break;
		case 'Includes':
			renderIncludesView(data);
			break;
		case 'IncludesCumulatedTime':
			renderIncludesCumulatedTimeView(data);
			break;
	}
}

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
		{ label: 'Optimization', color: getColor("OptModule") }
	];

	ctx.font = '11px sans-serif';
	categories.forEach((cat, i) => {
		ctx.fillStyle = cat.color;
		ctx.fillRect(x + (i * 120), y - 10, 10, 10);
		ctx.fillStyle = 'var(--vscode-editor-foreground)';
		ctx.fillText(cat.label, x + 15 + (i * 120), y);
	});
}

function renderFilesView(data: TraceResult): void {
	const canvas = document.getElementById('mainCanvas') as HTMLCanvasElement;
	const ctx = canvas.getContext('2d')!;

	const boxHeight = 42;
	const boxPadding = 6;
	const barHeight = 4;
	const leftMargin = 10;

	const parentWidth = canvas.parentElement?.clientWidth || 800;
	const maxCanvasWidth = parentWidth - 40;

	canvas.width = maxCanvasWidth;
	canvas.height = data.files.length * (boxHeight + boxPadding) + 100;

	const maxTime = Math.max(...data.files.map(f => f.TotalTime));

	ctx.clearRect(0, 0, canvas.width, canvas.height);
	drawLegend(ctx, 10, 20);

	data.files.forEach((file, i) => {
		const startY = i * (boxHeight + boxPadding) + 50;

		let fileName = file.Path.split(/[\\/]/).pop() || file.Path;
		fileName = fileName.replace('.cpp.json', '.cpp').replace('.json', '');

		const boxWidth = (file.TotalTime / maxTime) * (maxCanvasWidth - 100);
		const finalBoxWidth = Math.max(boxWidth, 150);

		ctx.fillStyle = '#2d2d2d';
		ctx.strokeStyle = '#454545';
		roundRect(ctx, leftMargin, startY, finalBoxWidth, boxHeight, 4, true, true);

		ctx.fillStyle = '#e0e0e0';
		ctx.font = '13px sans-serif';
		ctx.fillText(fileName, leftMargin + 10, startY + 16);

		const sourceW = (file.SourceTime / file.TotalTime) * finalBoxWidth;
		const codeGenW = (file.CodeGenTime / file.TotalTime) * finalBoxWidth;
		const optimW = (file.OptimTime / file.TotalTime) * finalBoxWidth;

		let barY = startY + 25;

		ctx.fillStyle = getColor("Source");
		ctx.fillRect(leftMargin + 10, barY, sourceW, barHeight);
		barY += barHeight;

		ctx.fillStyle = getColor("InstantiateFunction");
		ctx.fillRect(leftMargin + 10, barY, codeGenW, barHeight);
		barY += barHeight;

		ctx.fillStyle = getColor("OptModule");
		ctx.fillRect(leftMargin + 10, barY, optimW, barHeight);
		barY += barHeight;

		ctx.fillStyle = '#888888';
		ctx.font = '10px sans-serif';
		const timeStr = `${(file.TotalTime / 1000).toFixed(1)} ms`;
		ctx.fillText(timeStr, leftMargin + finalBoxWidth + 10, startY + 25);
	});

	canvas.onmousemove = (e) => {
		const rect = canvas.getBoundingClientRect();
		const y = e.clientY - rect.top - 60;
		const index = Math.floor(y / (boxHeight + boxPadding));
		if (index >= 0 && index < data.files.length) {
			canvas.title = data.files[index].Path;
			canvas.style.cursor = 'pointer';
		} else {
			canvas.style.cursor = 'default';
		}
	};
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number, fill: boolean, stroke: boolean) {
	ctx.beginPath();
	ctx.moveTo(x + radius, y);
	ctx.lineTo(x + width - radius, y);
	ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
	ctx.lineTo(x + width, y + height - radius);
	ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
	ctx.lineTo(x + radius, y + height);
	ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
	ctx.lineTo(x, y + radius);
	ctx.quadraticCurveTo(x, y, x + radius, y);
	ctx.closePath();
	if (fill) { ctx.fill(); }
	if (stroke) { ctx.stroke(); }
}

function renderIncludesView(data: TraceResult): void {
	const canvas = document.getElementById('mainCanvas') as HTMLCanvasElement;
	const ctx = canvas.getContext('2d')!;

	const boxHeight = 42;
	const boxPadding = 6;
	const leftMargin = 10;

	const parentWidth = canvas.parentElement?.clientWidth || 800;
	const maxCanvasWidth = parentWidth - 40;

	canvas.width = maxCanvasWidth;
	canvas.height = data.includes.length * (boxHeight + boxPadding) + 100;

	const maxTime = Math.max(...data.includes.map(f => f.Time));

	ctx.clearRect(0, 0, canvas.width, canvas.height);

	data.includes.forEach((file, i) => {
		const startY = i * (boxHeight + boxPadding) + 50;

		const fileName = file.Path.split(/[\\/]/).pop() || file.Path;

		const boxWidth = (file.Time / maxTime) * (maxCanvasWidth - 100);
		const finalBoxWidth = Math.max(boxWidth, 150);

		ctx.fillStyle = '#2d2d2d';
		ctx.strokeStyle = '#454545';
		roundRect(ctx, leftMargin, startY, finalBoxWidth, boxHeight, 4, true, true);

		ctx.fillStyle = '#e0e0e0';
		ctx.font = '13px sans-serif';
		ctx.fillText(fileName, leftMargin + 10, startY + 16);

		ctx.fillStyle = '#888888';
		ctx.font = '10px sans-serif';
		const timeStr = `${(file.Time / 1000).toFixed(1)} ms`;
		ctx.fillText(timeStr, leftMargin + finalBoxWidth + 10, startY + 25);
	});

	canvas.onmousemove = (e) => {
		const rect = canvas.getBoundingClientRect();
		const y = e.clientY - rect.top - 60;
		const index = Math.floor(y / (boxHeight + boxPadding));
		if (index >= 0 && index < data.includes.length) {
			canvas.title = data.includes[index].Path;
			canvas.style.cursor = 'pointer';
		} else {
			canvas.style.cursor = 'default';
		}
	};
}


function renderIncludesCumulatedTimeView(data: TraceResult): void {
	const canvas = document.getElementById('mainCanvas') as HTMLCanvasElement;
	const ctx = canvas.getContext('2d')!;

	const boxHeight = 42;
	const boxPadding = 6;
	const leftMargin = 10;

	const parentWidth = canvas.parentElement?.clientWidth || 800;
	const maxCanvasWidth = parentWidth - 40;

	canvas.width = maxCanvasWidth;
	canvas.height = data.cumulatedIncludes.length * (boxHeight + boxPadding) + 100;

	const maxTime = Math.max(...data.cumulatedIncludes.map(f => f.TotalTime));

	ctx.clearRect(0, 0, canvas.width, canvas.height);

	data.cumulatedIncludes.forEach((file, i) => {
		const startY = i * (boxHeight + boxPadding) + 50;

		const fileName = file.Path.split(/[\\/]/).pop() || file.Path;

		const boxWidth = (file.TotalTime / maxTime) * (maxCanvasWidth - 100);
		const finalBoxWidth = Math.max(boxWidth, 150);

		ctx.fillStyle = '#2d2d2d';
		ctx.strokeStyle = '#454545';
		roundRect(ctx, leftMargin, startY, finalBoxWidth, boxHeight, 4, true, true);

		ctx.fillStyle = '#e0e0e0';
		ctx.font = '13px sans-serif';
		ctx.fillText(fileName, leftMargin + 10, startY + 16);

		ctx.fillStyle = '#888888';
		ctx.font = '10px sans-serif';
		const timeStr = `${(file.TotalTime / 1000).toFixed(1)} ms`;
		ctx.fillText(timeStr, leftMargin + finalBoxWidth + 10, startY + 25);
	});

	canvas.onmousemove = (e) => {
		const rect = canvas.getBoundingClientRect();
		const y = e.clientY - rect.top - 60;
		const index = Math.floor(y / (boxHeight + boxPadding));
		if (index >= 0 && index < data.cumulatedIncludes.length) {
			canvas.title = data.cumulatedIncludes[index].Path;
			canvas.style.cursor = 'pointer';
		} else {
			canvas.style.cursor = 'default';
		}
	};
}

window.addEventListener('DOMContentLoaded', initTabs);