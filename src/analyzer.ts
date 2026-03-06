import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface FileStats {
	Path: string;
	TotalTime: number;
	SourceTime: number;
	CodeGenTime: number;
	OptimTime: number;
}

export interface IncludeStats {
	Path: string;
	Time: number;
	Count: number;
	IncludedBy: string[];
}

export interface CodeGenStats {
	Symbol: string;
	Time: number;
	Count: number;
}

export interface CumulatedIncludeStats {
	Path: string;
	TotalTime: number;
	Count: number;
	IncludedBy: string[];
}

export interface TraceResult {
	files: FileStats[];
	includes: IncludeStats[];
	codeGen: CodeGenStats[];
	cumulatedIncludes: CumulatedIncludeStats[];
}

export async function collectAndMergeTrace(tracePaths: string[]): Promise<TraceResult> {
	const finalResult: TraceResult = {
		files: [],
		includes: [],
		codeGen: [],
		cumulatedIncludes: []
	};

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: "Merging Traces",
		cancellable: true
	}, async (progress, token) => {

		for (let i = 0; i < tracePaths.length; i++) {
			if (token.isCancellationRequested) { break; }

			const filePath = tracePaths[i];

			if (await processClangTrace(filePath, finalResult) === false) {
				break;
			}

			progress.report({
				increment: (1 / tracePaths.length) * 100,
				message: `Analyzing ${path.basename(filePath)}`
			});
		}
	});

	finalResult.files.sort((a, b) => b.TotalTime - a.TotalTime);
	finalResult.includes.sort((a, b) => b.Time - a.Time);
	finalResult.includes.forEach(i => i.IncludedBy.sort((a, b) => a.localeCompare(b)));
	finalResult.codeGen.sort((a, b) => b.Time - a.Time);
	finalResult.cumulatedIncludes.sort((a, b) => b.TotalTime - a.TotalTime);
	finalResult.cumulatedIncludes.forEach(i => i.IncludedBy.sort((a, b) => a.localeCompare(b)));

	return finalResult;
}

function processClangTrace(filePath: string, traceResult: TraceResult): boolean {
	const rawData = fs.readFileSync(filePath, 'utf-8');
	const json = JSON.parse(rawData);
	const events = json.traceEvents;

	let fileStat: FileStats = {
		Path: filePath,
		TotalTime: 0,
		SourceTime: 0,
		CodeGenTime: 0,
		OptimTime: 0
	};

	const sourceEventStack: any[] = [];
	let firstSourceEventTs: number = Infinity;
	let lastSourceEventTs: number = 0;

	for (const event of events) {
		const name = event.name;
		const dur = event.dur || 0;
		const detail = event.args?.detail;

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

			let existingInc = traceResult.includes.find(i => i.Path === detail);
			if (existingInc) {
				existingInc.Time = Math.max(existingInc.Time, dur);
				existingInc.Count += 1;
				if (!existingInc.IncludedBy.includes(filePath)) { existingInc.IncludedBy.push(filePath); }
			} else {
				traceResult.includes.push({
					Path: detail,
					Time: dur,
					Count: 1,
					IncludedBy: [filePath]
				});
			}

			let existingCumul = traceResult.cumulatedIncludes.find(c => c.Path === detail);
			if (existingCumul) {
				existingCumul.TotalTime += dur;
				existingCumul.Count += 1;
				if (!existingCumul.IncludedBy.includes(filePath)) { existingCumul.IncludedBy.push(filePath); }
			} else {
				traceResult.cumulatedIncludes.push({
					Path: detail,
					TotalTime: dur,
					Count: 1,
					IncludedBy: [filePath]
				});
			}
			continue;
		}

		if (name === "Total ExecuteCompiler") {
			fileStat.TotalTime = dur;
		}
		/* Bugged ?
		else if (name === "Total Source") {
			fileStat.SourceTime = dur;
		}
		*/
		else if (name === "Total InstantiateFunction") {
			fileStat.CodeGenTime = dur;
		}
		else if (name === "Total OptModule") {
			fileStat.OptimTime = dur;
		}
	}

	if (lastSourceEventTs !== 0) {
		fileStat.SourceTime = lastSourceEventTs - firstSourceEventTs;
	}

	traceResult.files.push(fileStat);

	return true;
}
