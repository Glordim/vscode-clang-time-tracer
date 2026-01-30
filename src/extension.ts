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
                if (e.affectsConfiguration('iwyu.compileCommands.path')) {
                    this.outputChannel.appendLine("IWYU: Settings changed, reloading database...");
                    
                    this.initWatcher(folder); 
                    this.loadingPromise = this.loadDatabase(folder);
                }
            });
		}
	}

	private initWatcher(folder: vscode.WorkspaceFolder) {
		this.watcher?.dispose();
		const config = vscode.workspace.getConfiguration('iwyu');
		const compileCommandsPath = config.get<string>('compileCommands.path') || "";
		const dbUri = vscode.Uri.joinPath(folder.uri, compileCommandsPath, 'compile_commands.json');
		this.watcher = vscode.workspace.createFileSystemWatcher(dbUri.fsPath);

		const reload = () => {
			this.outputChannel.appendLine("IWYU: Database change, reloading cache...");
			this.loadingPromise = this.loadDatabase(folder);
		};

		this.watcher.onDidChange(reload);
		this.watcher.onDidCreate(reload);
		this.watcher.onDidDelete(() => {
			this.commands.clear();
			this.loadingPromise = undefined;
			this.outputChannel.appendLine("IWYU: Database deleted, cache cleared.");
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
		const config = vscode.workspace.getConfiguration('iwyu');
		const compileCommandsPath = config.get<string>('compileCommands.path') || "";
		const dbUri = vscode.Uri.joinPath(folder.uri, compileCommandsPath, 'compile_commands.json');
		if (!fs.existsSync(dbUri.fsPath)) {
			this.outputChannel.appendLine(`IWYU: Database not found at ${dbUri.fsPath}`);
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
			this.outputChannel.appendLine(`IWYU: Loaded ${this.commands.size} compile commands.`);
		} catch (err) {
			this.outputChannel.appendLine(`IWYU: Error parsing database: ${err}`);
		}
	}

	public dispose() {
		this.watcher?.dispose();
	}
}

// --- Extension Activation ---

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel("Clang Time Tracer");
	const db = new CompilationDatabase(outputChannel);

	context.subscriptions.push(outputChannel, db);

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

	context.subscriptions.push(disposableFix);
}

export function deactivate() { }