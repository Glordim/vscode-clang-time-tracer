import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface FileStats {
	tracePath: string;
	sourcePath: string;
	totalTime: number;
	sourceTime: number;
	templateTime: number;
	optimTime: number;
}

export interface IncludeStats {
	path: string;
	maxTime: number;
	count: number;
	includedBy: string[];
}

export interface CumulatedIncludeStats {
	path: string;
	totalTime: number;
	count: number;
	includedBy: string[];
}

export interface TraceResult {
	files: FileStats[];
	includes: IncludeStats[];
	cumulatedIncludes: CumulatedIncludeStats[];
}

export async function collectAndMergeTrace(tracePaths: { tracePath: string, sourcePath: string }[]): Promise<TraceResult> {
	const finalResult: TraceResult = {
		files: [],
		includes: [],
		cumulatedIncludes: []
	};

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: "Merging Traces",
		cancellable: true
	}, async (progress, token) => {

		for (let i = 0; i < tracePaths.length; i++) {
			if (token.isCancellationRequested) { break; }

			const { tracePath, sourcePath } = tracePaths[i];

			if (processClangTrace(tracePath, sourcePath, finalResult) === false) {
				break;
			}

			progress.report({
				increment: (1 / tracePaths.length) * 100,
				message: `Analyzing ${path.basename(tracePath)}`
			});
		}
	});

	finalResult.files.sort((a, b) => b.totalTime - a.totalTime);
	finalResult.includes.sort((a, b) => b.maxTime - a.maxTime);
	finalResult.includes.forEach(i => i.includedBy.sort((a, b) => a.localeCompare(b)));
	finalResult.cumulatedIncludes.sort((a, b) => b.totalTime - a.totalTime);
	finalResult.cumulatedIncludes.forEach(i => i.includedBy.sort((a, b) => a.localeCompare(b)));

	return finalResult;
}

function processClangTrace(filePath: string, sourcePath: string, traceResult: TraceResult): boolean {
	const rawData = fs.readFileSync(filePath, 'utf-8');
	const json = JSON.parse(rawData);
	const events = json.traceEvents;

	let fileStat: FileStats = {
		tracePath: filePath,
		sourcePath: sourcePath,
		totalTime: 0,
		sourceTime: 0,
		templateTime: 0,
		optimTime: 0
	};

	const sourceEventStack: any[] = [];
	let firstSourceEventTs: number = Infinity;
	let lastSourceEventTs: number = 0;

	for (const event of events) {
		const name = event.name;
		const dur = event.dur || 0;

		if (event.cat === "Source" && event.ph === "b") {
			sourceEventStack.push(event);
			firstSourceEventTs = Math.min(firstSourceEventTs, event.ts);
			continue;
		}

		if (event.cat === "Source" && event.ph === "e") {
			const startEvent = sourceEventStack.pop();
			if (!startEvent) { continue; }

			lastSourceEventTs = Math.max(lastSourceEventTs, event.ts);

			const dur = event.ts - startEvent.ts;
			const detail = startEvent.args?.detail;

			let existingInc = traceResult.includes.find(i => i.path === detail);
			if (existingInc) {
				existingInc.maxTime = Math.max(existingInc.maxTime, dur);
				existingInc.count += 1;
				if (!existingInc.includedBy.includes(sourcePath)) { existingInc.includedBy.push(sourcePath); }
			} else {
				traceResult.includes.push({
					path: detail,
					maxTime: dur,
					count: 1,
					includedBy: [sourcePath]
				});
			}

			let existingCumul = traceResult.cumulatedIncludes.find(c => c.path === detail);
			if (existingCumul) {
				existingCumul.totalTime += dur;
				existingCumul.count += 1;
				if (!existingCumul.includedBy.includes(sourcePath)) { existingCumul.includedBy.push(sourcePath); }
			} else {
				traceResult.cumulatedIncludes.push({
					path: detail,
					totalTime: dur,
					count: 1,
					includedBy: [sourcePath]
				});
			}
			continue;
		}

		if (name === "Total ExecuteCompiler") {
			fileStat.totalTime = dur;
		}
		/* Bugged ?
		else if (name === "Total Source") {
			fileStat.sourceTime = dur;
		}
		*/
		else if (name === "Total InstantiateFunction") {
			fileStat.templateTime = dur;
		}
		else if (name === "Total OptModule") {
			fileStat.optimTime = dur;
		}
	}

	if (lastSourceEventTs !== 0) {
		fileStat.sourceTime = lastSourceEventTs - firstSourceEventTs;
	}

	traceResult.files.push(fileStat);

	return true;
}
