import * as vscode from 'vscode';
import { BasePanel } from './basePanel';

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

		this._panel.webview.html = this._getHtmlContent('folder_view.html', 'folder_view.js', data);

		this._panel.webview.onDidReceiveMessage(message => {

		}, null, this._disposables);
	}
}