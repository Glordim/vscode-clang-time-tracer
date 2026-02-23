import * as vscode from 'vscode';
import * as fs from 'fs';
import { spawn } from 'child_process';
import * as path from 'path';

// --- Interfaces ---

interface CompileEntry {
	command?: string;
	arguments?: string[];
	directory: string;
	file: string;
}

// --- Helper Functions ---

/**
 * Prepares execution arguments and injects -ftime-trace if missing
 */
function prepareArguments(entry: CompileEntry, extraArg: string): { exe: string, args: string[] } {
	let args: string[] = [];
	let exe = "";

	if (entry.arguments && entry.arguments.length > 0) {
		const [first, ...rest] = entry.arguments;
		exe = first ?? "";
		args = rest;
	} else if (entry.command) {
		const parts = entry.command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
		exe = parts[0] ?? "";

		args = parts.slice(1).map(arg => {
			if (/^['"].*['"]$/.test(arg)) {
				return arg.replace(/^['"]|['"]$/g, '');
			}
			return arg.replace(/"/g, '');
		});
	}

	const hasTraceFlag = args.some(arg => arg.includes("-ftime-trace") || arg.includes("/clang:-ftime-trace"));
	if (!hasTraceFlag) {
		args.unshift(extraArg);
	}

	return { exe, args };
}

/**
 * Resolves the expected .json trace file path based on compiler output flags
 */
function getTraceFilePath(entry: CompileEntry, args: string[]): string {
	let objPath = "";

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith('/Fo')) {
			objPath = arg.substring(3);
			break;
		} else if (arg === '-o' || arg === '/Fo') {
			objPath = args[i + 1];
			break;
		} else if (arg.startsWith('-o')) {
			objPath = arg.substring(2);
			break;
		}
	}

	let tracePath = "";
	if (objPath) {
		objPath = objPath.replace(/^['"]|['"]$/g, '');
		const parsed = path.parse(objPath);
		tracePath = path.join(parsed.dir, parsed.name + '.json');
	} else {
		const parsed = path.parse(entry.file);
		tracePath = parsed.name + '.json';
	}

	return path.isAbsolute(tracePath)
		? tracePath
		: path.resolve(entry.directory, tracePath);
}

async function pickFolderIntegrated(): Promise<vscode.Uri | undefined> {
	const root = vscode.workspace.workspaceFolders?.[0];
	const activeEditor = vscode.window.activeTextEditor;

	let currentPath: string;
	if (activeEditor && !activeEditor.document.isUntitled) {
		currentPath = path.dirname(activeEditor.document.uri.fsPath);
	} else if (root) {
		currentPath = root.uri.fsPath;
	} else {
		return undefined;
	}

	while (true) {
		const items: vscode.QuickPickItem[] = [
			{
				label: "$(check) Select this folder",
				detail: currentPath,
				alwaysShow: true
			},
			{ label: "", kind: vscode.QuickPickItemKind.Separator }
		];

		try {
			const files = await fs.promises.readdir(currentPath, { withFileTypes: true });

			const dirs = files
				.filter(f => f.isDirectory() && !f.name.startsWith('.'))
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(f => ({
					label: "$(folder) " + f.name,
					description: path.join(currentPath, f.name)
				}));

			const parentDir = path.dirname(currentPath);
			if (parentDir !== currentPath) {
				items.push({
					label: "$(arrow-left) Go back",
					description: parentDir
				});
			}

			items.push(...dirs);

			const selection = await vscode.window.showQuickPick(items, {
				placeHolder: `Currently in: ${path.basename(currentPath) || currentPath}`,
				ignoreFocusOut: true,
				matchOnDescription: true
			});

			if (!selection) { return undefined; }

			if (selection.label === "$(check) Select this folder") {
				return vscode.Uri.file(currentPath);
			} else {
				currentPath = selection.description!;
			}
		} catch (err) {
			vscode.window.showErrorMessage(`Error reading folder: ${err}`);
			return undefined;
		}
	}
}

async function buildEntry(entry: CompileEntry, outputChannel: vscode.OutputChannel): Promise<[number, string]> {
	const isClangCl = (entry.command || entry.arguments?.[0] || "").includes('clang-cl');
	const extraArg = isClangCl ? "/clang:-ftime-trace" : "-ftime-trace";

	const { exe, args } = prepareArguments(entry, extraArg);
	const tracePath = getTraceFilePath(entry, args);

	outputChannel.clear();
	outputChannel.show(true);

	outputChannel.appendLine(`[CWD] ${entry.directory}`);
	outputChannel.appendLine(`[Exec] ${exe} ${args.join(' ')}`);

	return new Promise<[number, string]>((resolve) => {
		const cp = spawn(exe, args, { cwd: entry.directory });

		cp.stdout?.on('data', d => outputChannel.append(d.toString()));
		cp.stderr?.on('data', d => outputChannel.append(d.toString()));

		cp.on('close', (code) => {
			const exitCode = code ?? -1;

			if (code !== 0) {
				vscode.window.showErrorMessage(`Compilation failed with exit code ${code}`);
			}

			resolve([exitCode, tracePath]);
		});

		cp.on('error', (err) => {
			outputChannel.appendLine(`[System Error] ${err.message}`);
			resolve([-1, tracePath]);
		});
	});
}

async function buildMultipleEntries(entries: CompileEntry[], outputChannel: vscode.OutputChannel) {
	const total = entries.length;
	let completed = 0;
	let hasErrorOccurred = false;

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: "Clang Time Tracer: Batch Compilation",
		cancellable: true
	}, async (progress, token) => {

		const limit = require('os').cpus().length;
		const queue = [...entries];
		let isCancelled = false;

		token.onCancellationRequested(() => {
			isCancelled = true;
			outputChannel.appendLine("\n[Batch] Cancellation requested by user.");
		});

		const runNext = async (): Promise<void> => {
			if (queue.length === 0 || isCancelled || hasErrorOccurred) { return; }

			const entry = queue.shift()!;
			const isClangCl = (entry.command || entry.arguments?.[0] || "").includes('clang-cl');
			const extraArg = isClangCl ? "/clang:-ftime-trace" : "-ftime-trace";
			const { exe, args } = prepareArguments(entry, extraArg);

			return new Promise((resolve) => {
				const cp = spawn(exe, args, { cwd: entry.directory });

				let stderrBuffer: string[] = [];

				//cp.stdout?.on('data', d => outputChannel.append(d.toString()));
				cp.stderr?.on('data', d => {
					stderrBuffer.push(d.toString());
				});

				cp.on('close', (code) => {
					completed++;
					const percent = Math.round((completed / total) * 100);
					const status = code === 0 ? "" : " [ERROR]";
					const fileName = path.basename(entry.file);

					outputChannel.appendLine(`[${completed}/${total}] ${fileName}${status}`);
					if (code !== 0) {
						hasErrorOccurred = true;
						outputChannel.append(stderrBuffer.join(''));
						resolve();
					}
					else {
						progress.report({
							increment: (1 / total) * 100,
							message: `${percent}% - ${fileName}`
						});
						resolve(runNext());
					}
				});

				token.onCancellationRequested(() => {
					cp.kill();
					resolve();
				});
			});
		};

		const workers = Array(Math.min(limit, queue.length)).fill(null).map(() => runNext());
		await Promise.all(workers);

		if (isCancelled) {
			vscode.window.showWarningMessage("Batch compilation cancelled by user.");
			outputChannel.appendLine("Compilation cancelled by user.");
		} else if (hasErrorOccurred) {
			vscode.window.showErrorMessage("Batch compilation stopped due to error. Check output channel.");
			outputChannel.appendLine("Compilation stopped due to error.");
		} else {
			vscode.window.showInformationMessage(`Successfully analyzed ${total} files.`);
			outputChannel.appendLine("Successfull");
		}
	});
}

// --- Main Classes ---

export class CompilationDatabase implements vscode.Disposable {
	private commands = new Map<string, CompileEntry>();
	private watcher?: vscode.FileSystemWatcher;
	private loadingPromise?: Promise<void>;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private outputChannel: vscode.OutputChannel) {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (folder) {
			this.initWatcher(folder);
			this.loadingPromise = this.loadDatabase(folder);

			this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('clangTimeTracer.compileCommands.path')) {
					this.initWatcher(folder);
					this.loadingPromise = this.loadDatabase(folder);
				}
			}));
		}
	}

	private getFullDatabasePath(folder: vscode.WorkspaceFolder): string {
		const config = vscode.workspace.getConfiguration('clangTimeTracer');
		const configPath = config.get<string>('compileCommands.path') || "";

		let resolvedPath = path.isAbsolute(configPath)
			? configPath
			: path.join(folder.uri.fsPath, configPath);

		if (!resolvedPath.toLowerCase().endsWith('.json')) {
			resolvedPath = path.join(resolvedPath, 'compile_commands.json');
		}

		return resolvedPath;
	}

	private initWatcher(folder: vscode.WorkspaceFolder) {
		this.watcher?.dispose();
		const dbPath = this.getFullDatabasePath(folder);

		this.watcher = vscode.workspace.createFileSystemWatcher(dbPath);
		this.disposables.push(this.watcher);

		const reload = () => { this.loadingPromise = this.loadDatabase(folder); };
		this.watcher.onDidChange(reload);
		this.watcher.onDidCreate(reload);
		this.watcher.onDidDelete(() => this.commands.clear());
	}

	private async loadDatabase(folder: vscode.WorkspaceFolder) {
		const dbPath = this.getFullDatabasePath(folder);

		if (!fs.existsSync(dbPath)) {
			this.outputChannel.appendLine(`[Error] file not found: ${dbPath}`);
			vscode.window.showWarningMessage(`Clang Time Tracer: compile_commands.json not found at ${dbPath}`);
			return;
		}

		try {
			const content = await fs.promises.readFile(dbPath, 'utf8');
			const data: CompileEntry[] = JSON.parse(content);
			this.commands.clear();

			for (const entry of data) {
				const fullPath = path.resolve(entry.directory, entry.file);
				this.commands.set(vscode.Uri.file(fullPath).toString(), entry);
			}
			this.outputChannel.appendLine(`[DB] Loaded ${this.commands.size} entries.`);
		} catch (err) {
			this.outputChannel.appendLine(`[Error] Failed to load compilation database: ${err}`);
			vscode.window.showErrorMessage(`Clang Time Tracer: Failed to read compile_commands.json. Check Output channel.`);
		}
	}

	public async getEntryForFile(uri: vscode.Uri): Promise<CompileEntry | undefined> {
		await this.loadingPromise;
		return this.commands.get(uri.toString());
	}

	public getAllEntriesInFolder(folderUri: vscode.Uri): CompileEntry[] {
		const folderPath = folderUri.fsPath.toLowerCase();
		const entries: CompileEntry[] = [];

		for (const [uriStr, entry] of this.commands.entries()) {
			const fileFsPath = vscode.Uri.parse(uriStr).fsPath.toLowerCase();
			if (fileFsPath.startsWith(folderPath)) {
				entries.push(entry);
			}
		}
		return entries;
	}

	public dispose() {
		this.watcher?.dispose();
		this.disposables.forEach(d => d.dispose());
	}
}

// --- Extension Lifecycle ---

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel("Clang Time Tracer");
	const db = new CompilationDatabase(outputChannel);
	context.subscriptions.push(outputChannel, db);

	const buildCmd = vscode.commands.registerCommand('clang_time_tracer.build_and_analyze', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) { return; }

		const entry = await db.getEntryForFile(editor.document.uri);
		if (!entry) {
			vscode.window.showErrorMessage("No compile command found for this file in compile_commands.json");
			return;
		}

		const [code, tracePath] = await buildEntry(entry, outputChannel);

		if (code === 0) {
			if (fs.existsSync(tracePath)) {
				TraceVisualizerPanel.createOrShow(context.extensionUri, tracePath);
			} else {
				outputChannel.appendLine(`[Error] Trace file not found at: ${tracePath}`);
			}
		}
	});

	context.subscriptions.push(buildCmd);

	const buildFolderCmd = vscode.commands.registerCommand('clang_time_tracer.build_folder', async (uri?: vscode.Uri) => {
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

		await buildMultipleEntries(entries, outputChannel);
	});

	context.subscriptions.push(buildFolderCmd);
}

// --- Webview Panel ---

export class TraceVisualizerPanel {
	private static _openPanels: Set<TraceVisualizerPanel> = new Set();
	private readonly _disposables: vscode.Disposable[] = [];

	private constructor(private readonly _panel: vscode.WebviewPanel, extensionUri: vscode.Uri, traceData: any) {
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
		this._panel.webview.html = this._getHtmlForWebview(this._panel.webview, extensionUri, traceData);
		this._panel.webview.onDidReceiveMessage(message => {
			switch (message.command) {
				case 'openFile': {
					const fullPath = message.path;

					const locationMatch = fullPath.match(/(?::\d+){1,2}/);

					let filePath = fullPath;
					let line = 0;
					let col = 0;

					if (locationMatch) {
						const endOfPathIndex = fullPath.indexOf(locationMatch[0]);
						filePath = fullPath.substring(0, endOfPathIndex);

						const parts = locationMatch[0].split(':').filter(Boolean);
						if (parts[0]) { line = Math.max(0, parseInt(parts[0], 10) - 1); }
						if (parts[1]) { col = Math.max(0, parseInt(parts[1], 10) - 1); }
					} else {
						filePath = fullPath.split(' <')[0];
					}

					const uri = vscode.Uri.file(filePath.trim());
					vscode.workspace.openTextDocument(uri).then(doc => {
						const pos = new vscode.Position(line, col);
						const selection = new vscode.Selection(pos, pos);

						vscode.window.showTextDocument(doc, { selection }).then(editor => {
							editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
						});
					}, err => {
						vscode.window.showErrorMessage("Unable to open file: " + filePath);
					});
					return;
				}
				case 'copyPath': {
					const endIdx = message.path.search(/:|<| /);
					const cleanPath = endIdx !== -1 ? message.path.substring(0, endIdx) : message.path;

					vscode.env.clipboard.writeText(cleanPath.trim());
					vscode.window.setStatusBarMessage("File path copied!", 2000);
					return;
				}
			}
		});
	}

	public static createOrShow(extensionUri: vscode.Uri, tracePath: string) {
		try {
			const traceData = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
			const baseTitle = `Time trace: ${path.basename(tracePath, '.json')}`;

			let finalTitle = baseTitle;

			const existingTabs = vscode.window.tabGroups.all
				.flatMap(group => group.tabs)
				.filter(tab => tab.label.startsWith(baseTitle));

			if (existingTabs.length > 0) {
				finalTitle = `${baseTitle} #${existingTabs.length + 1}`;
			}

			const panel = vscode.window.createWebviewPanel(
				'ClangTimeTrace',
				finalTitle,
				vscode.ViewColumn.Two,
				{
					enableScripts: true,
					retainContextWhenHidden: true,
					localResourceRoots: [
						vscode.Uri.joinPath(extensionUri, 'media'),
						vscode.Uri.joinPath(extensionUri, 'dist')
					]
				}
			);

			const newPanel = new TraceVisualizerPanel(panel, extensionUri, traceData);
			this._openPanels.add(newPanel);

		} catch (err) {
			vscode.window.showErrorMessage(`Failed to load trace file: ${err}`);
		}
	}

	private _getHtmlForWebview(webview: vscode.Webview, extensionUri: vscode.Uri, traceData: any) {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'canvas.js'));
		const htmlPath = vscode.Uri.joinPath(extensionUri, 'media', 'view.html');

		// Basic XSS protection for the injected JSON string
		const sanitizedData = JSON.stringify(traceData).replace(/</g, '\\u003c');

		return fs.readFileSync(htmlPath.fsPath, 'utf8')
			.replace('{{scriptUri}}', scriptUri.toString())
			.replace('{{traceData}}', sanitizedData);
	}

	public dispose() {
		TraceVisualizerPanel._openPanels.delete(this);
		this._panel.dispose();
		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) { x.dispose(); }
		}
	}
}