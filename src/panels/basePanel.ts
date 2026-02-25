import * as vscode from 'vscode';
import * as fs from 'fs';

export abstract class BasePanel {
	protected readonly _panel: vscode.WebviewPanel;
	protected readonly _extensionUri: vscode.Uri;
	protected _disposables: vscode.Disposable[] = [];

	constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
		this._panel = panel;
		this._extensionUri = extensionUri;

		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
	}

	protected _getHtmlContent(htmlFileName: string, scriptFileName: string, data: any): string {
		const webview = this._panel.webview;

		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', scriptFileName));
		const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'media', htmlFileName);

		const sanitizedData = JSON.stringify(data).replace(/</g, '\\u003c');

		return fs.readFileSync(htmlPath.fsPath, 'utf8')
			.replace('{{scriptUri}}', scriptUri.toString())
			.replace('{{traceData}}', sanitizedData);
	}

	public dispose() {
		this._panel.dispose();
		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) { x.dispose(); }
		}
	}
}
