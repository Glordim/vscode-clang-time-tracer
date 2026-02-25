const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	const extensionCtx = await esbuild.context({
		entryPoints: ['src/extension.ts'],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		plugins: [esbuildProblemMatcherPlugin],
	});

	const webviewCtx = await esbuild.context({
		entryPoints: ['src/webviews/file_view.ts'],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		platform: 'browser',
		outfile: 'dist/file_view.js',
	});

	const webviewCtx2 = await esbuild.context({
		entryPoints: ['src/webviews/folder_view.ts'],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		platform: 'browser',
		outfile: 'dist/folder_view.js',
	});

	if (watch) {
		await Promise.all([
			extensionCtx.watch(),
			webviewCtx.watch(),
			webviewCtx2.watch()
		]);
	} else {
		await Promise.all([
			extensionCtx.rebuild(),
			webviewCtx.rebuild(),
			webviewCtx2.rebuild()
		]);
		await extensionCtx.dispose();
		await webviewCtx.dispose();
		await webviewCtx2.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
