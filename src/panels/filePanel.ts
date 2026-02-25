import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BasePanel } from './basePanel';

export class TraceVisualizerPanel extends BasePanel {

	public static createOrShow(extensionUri: vscode.Uri, tracePath: string) {
		const traceData = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
		const baseTitle = `Time trace: ${path.basename(tracePath, '.json')}`;

		const existingTabs = vscode.window.tabGroups.all
			.flatMap(group => group.tabs)
			.filter(tab => tab.label.startsWith(baseTitle));
		const finalTitle = existingTabs.length > 0 ? `${baseTitle} #${existingTabs.length + 1}` : baseTitle;

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

		new TraceVisualizerPanel(panel, extensionUri, traceData);
	}

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, traceData: any) {
		super(panel, extensionUri);

		this._panel.webview.html = this._getHtmlContent('file_view.html', 'file_view.js', traceData);

		this._panel.webview.onDidReceiveMessage(message => {
			switch (message.command) {
				case 'openFile':
					this._handleOpenFile(message.path);
					return;
				case 'copyPath':
					this._handleCopyPath(message.path);
					return;
			}
		}, null, this._disposables);
	}

	private _handleOpenFile(fullPath: string) {
		const locationMatch = fullPath.match(/(?::\d+){1,2}/);
		let filePath = fullPath;
		let line = 0, col = 0;

		if (locationMatch) {
			filePath = fullPath.substring(0, fullPath.indexOf(locationMatch[0]));
			const parts = locationMatch[0].split(':').filter(Boolean);
			line = Math.max(0, parseInt(parts[0], 10) - 1);
			col = Math.max(0, parseInt(parts[1], 10) - 1);
		} else {
			filePath = fullPath.split(' <')[0];
		}

		const uri = vscode.Uri.file(filePath.trim());
		vscode.workspace.openTextDocument(uri).then(doc => {
			const pos = new vscode.Position(line, col);
			const selection = new vscode.Selection(pos, pos);
			vscode.window.showTextDocument(doc, { selection, viewColumn: vscode.ViewColumn.One });
		}, () => vscode.window.showErrorMessage("Unable to open: " + filePath));
	}

	private _handleCopyPath(rawPath: string) {
		const endIdx = rawPath.search(/:|<| /);
		const cleanPath = endIdx !== -1 ? rawPath.substring(0, endIdx) : rawPath;
		vscode.env.clipboard.writeText(cleanPath.trim());
		vscode.window.setStatusBarMessage("File path copied!", 2000);
	}
}
