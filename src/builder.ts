import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import path from "path";
import { spawn } from 'child_process';
import { CompileEntry } from "./compilationDatabase";

function splitCommand(command: string): string[] {
	const args: string[] = [];
	let current = '';
	let inDouble = false;
	let inSingle = false;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];

		if (inSingle) {
			if (ch === "'") { inSingle = false; }
			else { current += ch; }
		} else if (inDouble) {
			if (ch === '"') {
				inDouble = false;
			} else if (ch === '\\' && i + 1 < command.length && (command[i + 1] === '"' || command[i + 1] === '\\')) {
				current += command[++i];
			} else {
				current += ch;
			}
		} else {
			if (ch === ' ' || ch === '\t') {
				if (current.length > 0) { args.push(current); current = ''; }
			} else if (ch === '"') {
				inDouble = true;
			} else if (ch === "'") {
				inSingle = true;
			} else if (ch === '\\' && i + 1 < command.length && command[i + 1] === '"') {
				current += command[++i];
			} else {
				current += ch;
			}
		}
	}

	if (current.length > 0) { args.push(current); }
	return args;
}

function prepareArguments(entry: CompileEntry, extraArg: string): { exe: string, args: string[] } {
	let args: string[] = [];
	let exe = "";

	if (entry.arguments && entry.arguments.length > 0) {
		const [first, ...rest] = entry.arguments;
		exe = first ?? "";
		args = rest;
	} else if (entry.command) {
		const parts = splitCommand(entry.command);
		exe = parts[0] ?? "";
		args = parts.slice(1);
	}

	const hasTraceFlag = args.some(arg => arg.includes("-ftime-trace") || arg.includes("/clang:-ftime-trace"));
	if (!hasTraceFlag) {
		args.unshift(extraArg);
	}

	return { exe, args };
}

function findOutputArg(args: string[]): { index: number, count: number, value: string } | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith('/Fo')) {
			return { index: i, count: 1, value: arg.substring(3) };
		} else if (arg === '-o' || arg === '/clang:-o' || arg === '/Fo') {
			return { index: i, count: 2, value: args[i + 1] ?? "" };
		} else if (arg.startsWith('-o')) {
			return { index: i, count: 1, value: arg.substring(2) };
		}
		else if (arg.startsWith('/clang:-o')) {
			return { index: i, count: 1, value: arg.substring(9) };
		}
	}
	return undefined;
}

// Dependency files (-MD -MF foo.d ...) belong to the borrowed source file: don't overwrite them.
// With clang-cl only the /clang: forms are dependency flags (-MD / -MT select the runtime library).
function stripDependencyArgs(args: string[], isClangCl: boolean): string[] {
	const result: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		let flag = arg;
		if (isClangCl) {
			if (!arg.startsWith('/clang:')) { result.push(arg); continue; }
			flag = arg.substring(7);
		}

		if (/^-M[FTQJ]$/.test(flag)) {
			i++;
		} else if (!/^-M([FTQJ].+|M?D?|[PGV])$/.test(flag)) {
			result.push(arg);
		}
	}
	return result;
}

function isSamePath(a: string, b: string): boolean {
	// Windows and macOS file systems are case-insensitive by default.
	const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
	return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const HEADER_LANGUAGES: Record<string, string> = { '.c': 'c', '.m': 'objective-c', '.mm': 'objective-c++' };

// Turns the compile command of a source file into one that compiles `headerPath` as if it were a source file.
function makeHeaderEntry(entry: CompileEntry, headerPath: string, isClangCl: boolean): CompileEntry | undefined {
	const parts = entry.arguments && entry.arguments.length > 0 ? entry.arguments : splitCommand(entry.command ?? "");
	const exe = parts[0] ?? "";
	const args = stripDependencyArgs(parts.slice(1), isClangCl);

	// Give the header its own output so the object file (and trace) of the borrowed source is left untouched.
	const output = findOutputArg(args);
	const oldOutput = (output?.value ?? "").replace(/^['"]|['"]$/g, '');
	if (output) {
		args.splice(output.index, output.count);
	}
	const isOutputDir = /[\\/]$/.test(oldOutput);
	const outputDir = isOutputDir ? oldOutput : path.dirname(oldOutput);
	const outputExt = (!isOutputDir && path.extname(oldOutput)) || (isClangCl ? '.obj' : '.o');
	const newOutput = path.join(outputDir, path.basename(headerPath) + outputExt);

	const sourcePath = path.resolve(entry.directory, entry.file);
	const sourceIndex = args.findIndex(arg => isSamePath(path.resolve(entry.directory, arg), sourcePath));
	if (sourceIndex === -1) {
		return undefined;
	}
	args[sourceIndex] = headerPath;

	const language = HEADER_LANGUAGES[path.extname(entry.file).toLowerCase()] ?? 'c++';
	let extraArgs: string[];
	if (isClangCl) {
		// A repeated /TP or /TC triggers -Woverriding-option, so only add it when missing.
		const languageArg = language === 'c' ? 'TC' : 'TP';
		const hasLanguageArg = args.includes('/' + languageArg) || args.includes('-' + languageArg);
		extraArgs = hasLanguageArg ? [] : ['/' + languageArg];
		extraArgs.push(`/Fo${newOutput}`);
	} else {
		extraArgs = ['-x', language, '-o', newOutput];
	}
	extraArgs.push('-Wno-pragma-once-outside-header');

	// Everything after "--" is an input file, so the flags must go before it.
	const separatorIndex = args.indexOf('--');
	const insertIndex = separatorIndex !== -1 && separatorIndex < sourceIndex ? separatorIndex : sourceIndex;
	args.splice(insertIndex, 0, ...extraArgs);

	return { arguments: [exe, ...args], directory: entry.directory, file: headerPath };
}

function getTraceFilePath(entry: CompileEntry, args: string[]): string {
	let objPath = findOutputArg(args)?.value ?? "";

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

export async function buildEntry(entry: CompileEntry, outputChannel: vscode.OutputChannel): Promise<[boolean, string]> {
	const isClangCl = (entry.command || entry.arguments?.[0] || "").includes('clang-cl');
	const extraArg = isClangCl ? "/clang:-ftime-trace" : "-ftime-trace";

	const { exe, args } = prepareArguments(entry, extraArg);
	const tracePath = getTraceFilePath(entry, args);

	fs.mkdirSync(path.dirname(tracePath), { recursive: true });

	outputChannel.appendLine(`[CWD] ${entry.directory}`);
	outputChannel.appendLine(`[Exec] ${exe} ${args.join(' ')}`);

	return new Promise<[boolean, string]>((resolve) => {
		const cp = spawn(exe, args, { cwd: entry.directory });

		cp.stdout?.on('data', d => outputChannel.append(d.toString()));
		cp.stderr?.on('data', d => outputChannel.append(d.toString()));

		cp.on('close', (code) => {
			const exitCode = code ?? -1;

			if (exitCode !== 0) {
				vscode.window.showErrorMessage(`Compilation failed with exit code ${exitCode}`);
			}

			resolve([exitCode === 0, tracePath]);
		});

		cp.on('error', (err) => {
			outputChannel.appendLine(`[System Error] ${err.message}`);
			resolve([false, tracePath]);
		});
	});
}

// `entry` is the source file whose compile command is borrowed to compile the header.
export async function buildHeader(entry: CompileEntry, headerPath: string, outputChannel: vscode.OutputChannel): Promise<[boolean, string]> {
	const isClangCl = (entry.command || entry.arguments?.[0] || "").includes('clang-cl');

	const headerEntry = makeHeaderEntry(entry, headerPath, isClangCl);
	if (!headerEntry) {
		outputChannel.appendLine(`[Error] Unable to find ${entry.file} in its compile command.`);
		vscode.window.showErrorMessage(`Unable to adapt the compile command of ${path.basename(entry.file)} for this header`);
		return [false, ""];
	}

	outputChannel.appendLine(`[Header] Using the compile command of ${entry.file}`);
	return buildEntry(headerEntry, outputChannel);
}

export async function buildMultipleEntries(entries: CompileEntry[], outputChannel: vscode.OutputChannel): Promise<[boolean, { tracePath: string, sourcePath: string }[]]> {
	const total = entries.length;
	let completed = 0;
	let hasErrorOccurred = false;
	const generatedTracePaths: { tracePath: string, sourcePath: string }[] = [];

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: "Tracing",
		cancellable: true
	}, async (progress, token) => {

		const limit = os.cpus().length;
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
			const tracePath = getTraceFilePath(entry, args);

			fs.mkdirSync(path.dirname(tracePath), { recursive: true });

			return new Promise((resolve) => {
				const cp = spawn(exe, args, { cwd: entry.directory });

				let stderrBuffer: string[] = [];

				//cp.stdout?.on('data', d => outputChannel.append(d.toString()));
				cp.stderr?.on('data', d => {
					stderrBuffer.push(d.toString());
				});

				cp.on('close', (code) => {
					completed++;
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
							message: `${fileName}`
						});
						const sourcePath = path.isAbsolute(entry.file) ? entry.file : path.resolve(entry.directory, entry.file);
						generatedTracePaths.push({ tracePath, sourcePath });
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

	return [hasErrorOccurred === false, generatedTracePaths];
}
