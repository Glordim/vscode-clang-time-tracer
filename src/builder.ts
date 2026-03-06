import * as vscode from 'vscode';
import * as os from 'os';
import path from "path";
import { spawn } from 'child_process';
import { CompileEntry } from "./compilationDatabase";

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


export async function buildEntry(entry: CompileEntry, outputChannel: vscode.OutputChannel): Promise<[boolean, string]> {
	const isClangCl = (entry.command || entry.arguments?.[0] || "").includes('clang-cl');
	const extraArg = isClangCl ? "/clang:-ftime-trace" : "-ftime-trace";

	const { exe, args } = prepareArguments(entry, extraArg);
	const tracePath = getTraceFilePath(entry, args);

	outputChannel.clear();
	outputChannel.show(true);

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

export async function buildMultipleEntries(entries: CompileEntry[], outputChannel: vscode.OutputChannel): Promise<[boolean, string[]]> {
	const total = entries.length;
	let completed = 0;
	let hasErrorOccurred = false;
	const generatedTracePaths: string[] = [];

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: "Clang Time Tracer: Batch Compilation",
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
						generatedTracePaths.push(tracePath);
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
