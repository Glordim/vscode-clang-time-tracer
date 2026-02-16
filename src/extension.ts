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

	private initWatcher(folder: vscode.WorkspaceFolder) {
		this.watcher?.dispose();
		const config = vscode.workspace.getConfiguration('clangTimeTracer');
		const relPath = config.get<string>('compileCommands.path') || "";
		const dbPath = path.join(folder.uri.fsPath, relPath, 'compile_commands.json');

		this.watcher = vscode.workspace.createFileSystemWatcher(dbPath);
		this.disposables.push(this.watcher);

		const reload = () => { this.loadingPromise = this.loadDatabase(folder); };
		this.watcher.onDidChange(reload);
		this.watcher.onDidCreate(reload);
		this.watcher.onDidDelete(() => this.commands.clear());
	}

	private async loadDatabase(folder: vscode.WorkspaceFolder) {
		const config = vscode.workspace.getConfiguration('clangTimeTracer');
		const relPath = config.get<string>('compileCommands.path') || "";
		const dbUri = vscode.Uri.joinPath(folder.uri, relPath, 'compile_commands.json');

		if (!fs.existsSync(dbUri.fsPath)) { return; }

		try {
			const content = await fs.promises.readFile(dbUri.fsPath, 'utf8');
			const data: CompileEntry[] = JSON.parse(content);
			this.commands.clear();

			for (const entry of data) {
				const fullPath = path.resolve(entry.directory, entry.file);
				this.commands.set(vscode.Uri.file(fullPath).toString(), entry);
			}
			this.outputChannel.appendLine(`[DB] Loaded ${this.commands.size} entries.`);
		} catch (err) {
			this.outputChannel.appendLine(`[Error] Failed to load compilation database: ${err}`);
		}
	}

	public async getEntryForFile(uri: vscode.Uri): Promise<CompileEntry | undefined> {
		await this.loadingPromise;
		return this.commands.get(uri.toString());
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

		const isClangCl = (entry.command || entry.arguments?.[0] || "").includes('clang-cl');
		const extraArg = isClangCl ? "/clang:-ftime-trace" : "-ftime-trace";

		const { exe, args } = prepareArguments(entry, extraArg);

		outputChannel.clear();
		outputChannel.appendLine(`[CWD] ${entry.directory}`);
		outputChannel.appendLine(`[Exec] ${exe} ${args.join(' ')}`);
		outputChannel.show(true);

		const cp = spawn(exe, args, { cwd: entry.directory });

		cp.stdout?.on('data', d => outputChannel.append(d.toString()));
		cp.stderr?.on('data', d => outputChannel.append(d.toString()));

		cp.on('close', (code) => {
			if (code === 0) {
				const tracePath = getTraceFilePath(entry, args);
				if (fs.existsSync(tracePath)) {
					TraceVisualizerPanel.createOrShow(context.extensionUri, tracePath);
				} else {
					outputChannel.appendLine(`[Error] Trace file not found at: ${tracePath}`);
				}
			} else {
				vscode.window.showErrorMessage(`Compilation failed with exit code ${code}`);
			}
		});
	});

	context.subscriptions.push(buildCmd);
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