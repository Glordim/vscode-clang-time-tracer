import * as vscode from 'vscode';
import { BasePanel } from './basePanel';
import { TraceVisualizerPanel } from './filePanel';

export class FolderAnalysisPanel extends BasePanel {

	public static createOrShow(extensionUri: vscode.Uri, data: any, folderName: string) {
		const panel = vscode.window.createWebviewPanel(
			'ClangFolderAnalysis',
			`Folder Analysis: ${folderName}`,
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

		new FolderAnalysisPanel(panel, extensionUri, data);
	}

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, data: any) {
		super(panel, extensionUri);

		this._panel.webview.html = this._getHtmlContent('folder_view.html', 'folder_view.js');

		this._panel.webview.onDidReceiveMessage(message => {
			switch (message.command) {
				case 'openFile': {
					const uri = vscode.Uri.file(message.path.trim());
					vscode.workspace.openTextDocument(uri).then(doc => {
						vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
					}, () => vscode.window.showErrorMessage("Unable to open: " + message.path));
					return;
				}
				case 'openTrace':
					TraceVisualizerPanel.createOrShow(this._extensionUri, message.path.trim());
					return;
				case 'copyPath':
					vscode.env.clipboard.writeText(message.path.trim());
					vscode.window.setStatusBarMessage("File path copied!", 2000);
					return;
				case 'webviewReady':
					this._panel.webview.postMessage({
						command: 'initData',
						payload: data
					});
					return;
			}
		}, null, this._disposables);
	}
}
