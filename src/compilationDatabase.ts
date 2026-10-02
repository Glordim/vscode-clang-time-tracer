import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface CompileEntry {
	command?: string;
	arguments?: string[];
	directory: string;
	file: string;
}

const HEADER_EXTENSIONS = new Set(['.h', '.hh', '.hpp', '.hxx', '.h++', '.inl', '.ipp', '.tpp', '.tcc']);

export function isHeaderFile(uri: vscode.Uri): boolean {
	return HEADER_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase());
}

export class CompilationDatabase implements vscode.Disposable {
	private entries = new Map<string, CompileEntry>();
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
		this.watcher.onDidDelete(() => this.entries.clear());
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
			this.entries.clear();

			for (const entry of data) {
				const fullPath = path.resolve(entry.directory, entry.file);
				this.entries.set(vscode.Uri.file(fullPath).toString(), entry);
			}
			this.outputChannel.appendLine(`[DB] Loaded ${this.entries.size} entries.`);
		} catch (err) {
			this.outputChannel.appendLine(`[Error] Failed to load compilation database: ${err}`);
			vscode.window.showErrorMessage(`Clang Time Tracer: Failed to read compile_commands.json. Check Output channel.`);
		}
	}

	public async getEntryForFile(uri: vscode.Uri): Promise<CompileEntry | undefined> {
		await this.loadingPromise;
		return this.entries.get(uri.toString());
	}

	// Headers have no entry of their own: borrow the flags of the closest source file
	// (same name if possible, otherwise the one sharing the longest directory prefix).
	public async getEntryForHeader(uri: vscode.Uri): Promise<CompileEntry | undefined> {
		await this.loadingPromise;

		const header = path.parse(uri.fsPath.toLowerCase());
		const headerDirs = header.dir.split(path.sep);
		let bestEntry: CompileEntry | undefined;
		let bestScore = -1;

		for (const [uriStr, entry] of this.entries.entries()) {
			const source = path.parse(vscode.Uri.parse(uriStr).fsPath.toLowerCase());
			const sourceDirs = source.dir.split(path.sep);

			let score = 0;
			while (score < headerDirs.length && score < sourceDirs.length && headerDirs[score] === sourceDirs[score]) {
				score++;
			}
			if (source.name === header.name) {
				score += 1000;
			}

			if (score > bestScore) {
				bestScore = score;
				bestEntry = entry;
			}
		}
		return bestEntry;
	}

	public getAllEntriesInFolder(folderUri: vscode.Uri): CompileEntry[] {
		const folderPath = folderUri.fsPath.toLowerCase();
		const entries: CompileEntry[] = [];

		for (const [uriStr, entry] of this.entries.entries()) {
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
