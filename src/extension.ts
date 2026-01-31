import * as vscode from 'vscode';
import * as fs from 'fs';
import { spawn } from 'child_process';
import * as path from 'path';

// --- Interfaces & Types ---

interface CompileEntry {
	command: string;
	directory: string;
}

// --- Main Classes ---

export class CompilationDatabase {
	private commands: Map<string, CompileEntry> = new Map();
	private watcher?: vscode.FileSystemWatcher;
	private outputChannel: vscode.OutputChannel;
	private loadingPromise?: Promise<void>;
	private dbExists: boolean = false;

	constructor(outputChannel: vscode.OutputChannel) {
		this.outputChannel = outputChannel;
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (folder) {
			this.initWatcher(folder);
			this.loadingPromise = this.loadDatabase(folder);
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('clangTimeTracer.compileCommands.path')) {
					this.outputChannel.appendLine("IWYU: Settings changed, reloading database...");

					this.initWatcher(folder);
					this.loadingPromise = this.loadDatabase(folder);
				}
			});
		}
	}

	private initWatcher(folder: vscode.WorkspaceFolder) {
		this.watcher?.dispose();
		const config = vscode.workspace.getConfiguration('clangTimeTracer');
		const compileCommandsPath = config.get<string>('compileCommands.path') || "";
		const dbUri = vscode.Uri.joinPath(folder.uri, compileCommandsPath, 'compile_commands.json');
		this.watcher = vscode.workspace.createFileSystemWatcher(dbUri.fsPath);

		const reload = () => {
			this.outputChannel.appendLine("Database change, reloading cache...");
			this.loadingPromise = this.loadDatabase(folder);
		};

		this.watcher.onDidChange(reload);
		this.watcher.onDidCreate(reload);
		this.watcher.onDidDelete(() => {
			this.commands.clear();
			this.loadingPromise = undefined;
			this.outputChannel.appendLine("Database deleted, cache cleared.");
		});
	}

	public async getEntryForFile(fileUri: vscode.Uri): Promise<CompileEntry | undefined> {
		if (this.loadingPromise) await this.loadingPromise;
		return this.commands.get(fileUri.toString());
	}

	public async isValid(): Promise<boolean> {
		if (this.loadingPromise) {
			await this.loadingPromise;
		}
		return this.dbExists && this.commands.size > 0;
	}

	private async loadDatabase(folder: vscode.WorkspaceFolder) {
		const config = vscode.workspace.getConfiguration('clangTimeTracer');
		const compileCommandsPath = config.get<string>('compileCommands.path') || "";
		const dbUri = vscode.Uri.joinPath(folder.uri, compileCommandsPath, 'compile_commands.json');
		if (!fs.existsSync(dbUri.fsPath)) {
			this.outputChannel.appendLine(`Database not found at ${dbUri.fsPath}`);
			return;
		}

		this.dbExists = true;

		try {
			const content = await fs.promises.readFile(dbUri.fsPath, 'utf8');
			const data = JSON.parse(content);
			this.commands.clear();

			for (const entry of data) {
				if (entry.file) {
					const uri = vscode.Uri.file(path.resolve(entry.directory || folder.uri.fsPath, entry.file));
					const cmd = entry.command || (entry.arguments ? entry.arguments.join(' ') : undefined);
					if (cmd) {
						this.commands.set(uri.toString(), {
							command: cmd,
							directory: entry.directory || folder.uri.fsPath
						});
					}
				}
			}
			this.outputChannel.appendLine(`Loaded ${this.commands.size} compile commands.`);
		} catch (err) {
			this.outputChannel.appendLine(`Error parsing database: ${err}`);
		}
	}

	public dispose() {
		this.watcher?.dispose();
	}
}

function getTraceFilePath(entry: CompileEntry): string {
	const command = entry.command;
	let tracePath = "";

	// 1. Chercher le flag de sortie /Fo (clang-cl) ou -o (clang)
	// On utilise une Regex pour capturer ce qui suit immédiatement /Fo ou -o
	const outputMatch = command.match(/(?:[-/]Fo|[-]-?o)\s*([^\s"']+)/);

	if (outputMatch && outputMatch[1]) {
		const objPath = outputMatch[1];
		const parsed = path.parse(objPath);
		// On remplace l'extension (.obj, .o, etc.) par .json
		tracePath = path.join(parsed.dir, parsed.name + '.json');
	} else {
		// 2. Fallback : si pas de sortie spécifiée, Clang utilise le nom du fichier source
		// On cherche le dernier argument qui finit par une extension C++
		const args = command.split(/\s+/);
		const sourceFile = args.reverse().find(arg => arg.match(/\.(cpp|cc|cxx|c)$/i));

		if (sourceFile) {
			const parsed = path.parse(sourceFile);
			tracePath = parsed.name + '.json';
		}
	}

	// 3. Résolution du chemin
	if (!path.isAbsolute(tracePath)) {
		// Important : On résout par rapport au répertoire de compilation (directory)
		tracePath = path.resolve(entry.directory, tracePath);
	}

	return tracePath;
}

// --- Extension Activation ---

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel("Clang Time Tracer");
	const db = new CompilationDatabase(outputChannel);

	context.subscriptions.push(outputChannel, db);
	/*
		let disposable = vscode.commands.registerCommand('clang_time_tracer.analyze', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;
	
			const currentFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
			if (!currentFolder) {
				vscode.window.showErrorMessage("File is not in a workspace folder.");
				return;
			}
	
			if (!(await db.isValid())) {
				outputChannel.appendLine("Compilation database is invalid or not found.");
				vscode.window.showErrorMessage(
					"Compile_commands.json not found or invalid. Please ensure your project is configured (e.g., run CMake)."
				);
				return;
			}
	
			const entry = await db.getEntryForFile(editor.document.uri);
			if (!entry) {
				outputChannel.appendLine(`No entry found for ${editor.document.uri.fsPath}`);
				vscode.window.showWarningMessage("No compile command found for this file.");
				return;
			}
	
			const extraArg = "-ftime-trace";
			let finalCommand = entry.command;
			if (!finalCommand.includes(extraArg)) {
				finalCommand += " " + extraArg;
			}
	
			outputChannel.clear();
			outputChannel.appendLine(`[CWD] ${entry.directory}`);
			outputChannel.appendLine(`[Command] ${entry.command} -ftime-trace`);
			outputChannel.show(true);
	
			const process = spawn(finalCommand, {
				cwd: entry.directory,
				shell: false
			});
	
			process.stdout.on('data', (data) => outputChannel.append(data.toString()));
			process.stderr.on('data', (data) => outputChannel.append(data.toString()));
	
			process.on('error', (err) => {
				outputChannel.appendLine(`[Error] ${err.message}`);
				vscode.window.showErrorMessage(`Failed to start: ${err.message}`);
			});
	
			process.on('close', (code) => {
				outputChannel.appendLine(`\n[Finished] Exit code: ${code}`);
			});
		});
	
		context.subscriptions.push(disposable);
	*/

	let disposableFix = vscode.commands.registerCommand('clang_time_tracer.build_and_analyze', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		const currentFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
		if (!currentFolder) {
			vscode.window.showErrorMessage("File is not in a workspace folder.");
			return;
		}

		if (!(await db.isValid())) {
			outputChannel.appendLine("Compilation database is invalid or not found.");
			vscode.window.showErrorMessage(
				"Compile_commands.json not found or invalid. Please ensure your project is configured (e.g., run CMake)."
			);
			return;
		}

		const entry = await db.getEntryForFile(editor.document.uri);
		if (!entry) {
			outputChannel.appendLine(`No entry found for ${editor.document.uri.fsPath}`);
			vscode.window.showWarningMessage("No compile command found for this file.");
			return;
		}

		const isClangCl = entry.command.toLowerCase().includes('clang-cl');
		const extraArg = isClangCl ? "/clang:-ftime-trace" : "-ftime-trace";

		let finalCommand = entry.command;

		if (!finalCommand.includes("-ftime-trace")) {
			// On sépare l'exécutable du reste des arguments
			const firstSpaceIndex = finalCommand.indexOf(' ');
			if (firstSpaceIndex !== -1) {
				const exe = finalCommand.substring(0, firstSpaceIndex);
				const args = finalCommand.substring(firstSpaceIndex);
				finalCommand = `${exe} ${extraArg}${args}`;
			} else {
				finalCommand += ` ${extraArg}`;
			}
		}

		outputChannel.clear();
		outputChannel.appendLine(`[CWD] ${entry.directory}`);
		outputChannel.appendLine(`[Command] ${finalCommand}`);
		outputChannel.show(true);

		const process = spawn(finalCommand, {
			cwd: entry.directory,
			shell: true
		});

		process.stdout.on('data', (data) => outputChannel.append(data.toString()));
		process.stderr.on('data', (data) => outputChannel.append(data.toString()));

		process.on('error', (err) => {
			outputChannel.appendLine(`[Error] ${err.message}`);
			vscode.window.showErrorMessage(`Failed to start: ${err.message}`);
		});

		process.on('close', (code) => {
			outputChannel.appendLine(`\n[Finished] Exit code: ${code}`);

			if (code === 0) {
				const traceFilePath = getTraceFilePath(entry);
				if (fs.existsSync(traceFilePath)) {
					outputChannel.appendLine(`[Success] Trace file generated at: ${traceFilePath}`);
					TraceVisualizerPanel.createOrShow(context.extensionUri, traceFilePath);
				} else {
					outputChannel.appendLine(`[Warning] Trace file not found at: ${traceFilePath}. Check if Clang supports -ftime-trace.`);
				}
			}
		});
	});

	context.subscriptions.push(disposableFix);
}

export function deactivate() { }

export class TraceVisualizerPanel {
	public static currentPanel: TraceVisualizerPanel | undefined;
	private readonly _panel: vscode.WebviewPanel;
	private _disposables: vscode.Disposable[] = [];

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, traceData: any) {
		this._panel = panel;
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
		this._panel.webview.html = this._getHtmlForWebview(this._panel.webview, extensionUri, traceData);
	}

	public static createOrShow(extensionUri: vscode.Uri, tracePath: string) {
		const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

		try {
			const content = fs.readFileSync(tracePath, 'utf8');
			const traceData = JSON.parse(content);

			if (TraceVisualizerPanel.currentPanel) {
				TraceVisualizerPanel.currentPanel._panel.reveal(column);
				TraceVisualizerPanel.currentPanel._panel.webview.postMessage({ command: 'update', data: traceData });
				return;
			}

			const panel = vscode.window.createWebviewPanel(
				'clangTrace',
				`Trace: ${path.basename(tracePath)}`,
				column || vscode.ViewColumn.One,
				{
					enableScripts: true,
					localResourceRoots: [
						vscode.Uri.joinPath(extensionUri, 'media'),
						vscode.Uri.joinPath(extensionUri, 'dist')
					]
				}
			);

			TraceVisualizerPanel.currentPanel = new TraceVisualizerPanel(panel, extensionUri, traceData);
		} catch (err) {
			vscode.window.showErrorMessage(`Failed to read trace file: ${err}`);
		}
	}

	private _getHtmlForWebview(webview: vscode.Webview, extensionUri: vscode.Uri, traceData: any) {
		// 1. Définir les chemins vers les fichiers de ressources
		const scriptPath = vscode.Uri.joinPath(extensionUri, 'dist', 'canvas.js');
		//const stylePath = vscode.Uri.joinPath(extensionUri, 'media', 'style.css');
		const htmlPath = vscode.Uri.joinPath(extensionUri, 'media', 'view.html');

		// 2. Convertir en URIs compatibles Webview
		const scriptUri = webview.asWebviewUri(scriptPath);
		//const styleUri = webview.asWebviewUri(stylePath);

		// 3. Lire le fichier HTML
		let html = fs.readFileSync(htmlPath.fsPath, 'utf8');

		// 4. Remplacer les variables (Injection de données)
		html = html
			//.replace('{{styleUri}}', styleUri.toString())
			.replace('{{scriptUri}}', scriptUri.toString())
			.replace('{{traceData}}', JSON.stringify(traceData));

		return html;
	}

	public dispose() {
		TraceVisualizerPanel.currentPanel = undefined;
		this._panel.dispose();
		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) { x.dispose(); }
		}
	}
}

