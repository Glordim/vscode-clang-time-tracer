import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CompilationDatabase } from './compilationDatabase';
import { buildEntry, buildMultipleEntries } from './builder';
import { collectAndMergeTrace } from './analyzer';
import { TraceVisualizerPanel } from './panels/filePanel';
import { FolderAnalysisPanel } from './panels/folderPanel';
import { pickFolderIntegrated } from './ui';

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel("Clang Time Tracer");
	const db = new CompilationDatabase(outputChannel);
	context.subscriptions.push(outputChannel, db);

	const traceFile = vscode.commands.registerCommand('clang_time_tracer.trace_file', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) { return; }

		const entry = await db.getEntryForFile(editor.document.uri);
		if (!entry) {
			vscode.window.showErrorMessage("No compile command found for this file in compile_commands.json");
			return;
		}

		const [result, tracePath] = await buildEntry(entry, outputChannel);

		if (result) {
			if (fs.existsSync(tracePath)) {
				TraceVisualizerPanel.createOrShow(context.extensionUri, tracePath);
			} else {
				outputChannel.appendLine(`[Error] Trace file not found at: ${tracePath}`);
			}
		}
	});

	context.subscriptions.push(traceFile);

	const traceFolderCmd = vscode.commands.registerCommand('clang_time_tracer.trace_folder', async (uri?: vscode.Uri) => {
		let targetUri = uri;

		if (!targetUri) {
			targetUri = await pickFolderIntegrated();
		}

		if (!targetUri) { return; }

		const entries = db.getAllEntriesInFolder(targetUri);

		if (entries.length === 0) {
			vscode.window.showWarningMessage("No files found in the compilation database for this folder.");
			return;
		}

		outputChannel.clear();
		outputChannel.show(true);

		const [result, tracePaths] = await buildMultipleEntries(entries, outputChannel);
		if (result) {
			const traceResult = await collectAndMergeTrace(tracePaths);
			FolderAnalysisPanel.createOrShow(
				context.extensionUri,
				traceResult,
				path.basename(targetUri.fsPath)
			);
		}
	});

	context.subscriptions.push(traceFolderCmd);
}
