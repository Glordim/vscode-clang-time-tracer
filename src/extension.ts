import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CompilationDatabase, isHeaderFile } from './compilationDatabase';
import { buildEntry, buildHeader, buildMultipleEntries } from './builder';
import { collectAndMergeTrace } from './analyzer';
import { TraceFilePanel } from './panels/filePanel';
import { TraceFolderPanel } from './panels/folderPanel';
import { pickFolderIntegrated } from './ui';

const LAST_TRACE_FILE_KEY = 'lastTraceFile';
const LAST_TRACE_FOLDER_KEY = 'lastTraceFolder';

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel("Clang Time Tracer");
	const db = new CompilationDatabase(outputChannel);
	context.subscriptions.push(outputChannel, db);

	const runTraceFile = async (uri: vscode.Uri) => {
		let entry = await db.getEntryForFile(uri);
		const isHeader = !entry && isHeaderFile(uri);
		if (isHeader) {
			entry = await db.getEntryForHeader(uri);
		}
		if (!entry) {
			vscode.window.showErrorMessage("No compile command found for this file in compile_commands.json");
			return;
		}

		await context.workspaceState.update(LAST_TRACE_FILE_KEY, uri.toString());

		outputChannel.clear();
		outputChannel.show(true);

		const [result, tracePath] = isHeader
			? await buildHeader(entry, uri.fsPath, outputChannel)
			: await buildEntry(entry, outputChannel);

		if (result) {
			if (fs.existsSync(tracePath)) {
				TraceFilePanel.createOrShow(context.extensionUri, tracePath);
			} else {
				outputChannel.appendLine(`[Error] Trace file not found at: ${tracePath}`);
			}
		}
	};

	const traceFile = vscode.commands.registerCommand('clang_time_tracer.trace_file', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) { return; }

		await runTraceFile(editor.document.uri);
	});

	const retraceFile = vscode.commands.registerCommand('clang_time_tracer.retrace_file', async () => {
		const lastUri = context.workspaceState.get<string>(LAST_TRACE_FILE_KEY);
		if (!lastUri) {
			vscode.window.showInformationMessage("No previous file trace to re-run.");
			return;
		}

		await runTraceFile(vscode.Uri.parse(lastUri));
	});

	context.subscriptions.push(traceFile, retraceFile);

	const runTraceFolder = async (targetUri: vscode.Uri) => {
		const entries = db.getAllEntriesInFolder(targetUri);

		if (entries.length === 0) {
			vscode.window.showWarningMessage("No files found in the compilation database for this folder.");
			return;
		}

		await context.workspaceState.update(LAST_TRACE_FOLDER_KEY, targetUri.toString());

		outputChannel.clear();
		outputChannel.show(true);

		const [result, tracePaths] = await buildMultipleEntries(entries, outputChannel);
		if (result) {
			const traceResult = await collectAndMergeTrace(tracePaths);
			TraceFolderPanel.createOrShow(
				context.extensionUri,
				traceResult,
				path.basename(targetUri.fsPath)
			);
		}
	};

	const traceFolder = vscode.commands.registerCommand('clang_time_tracer.trace_folder', async (uri?: vscode.Uri) => {
		let targetUri = uri;

		if (!targetUri) {
			targetUri = await pickFolderIntegrated();
		}

		if (!targetUri) { return; }

		await runTraceFolder(targetUri);
	});

	const retraceFolder = vscode.commands.registerCommand('clang_time_tracer.retrace_folder', async () => {
		const lastUri = context.workspaceState.get<string>(LAST_TRACE_FOLDER_KEY);
		if (!lastUri) {
			vscode.window.showInformationMessage("No previous folder trace to re-run.");
			return;
		}

		await runTraceFolder(vscode.Uri.parse(lastUri));
	});

	context.subscriptions.push(traceFolder, retraceFolder);
}
