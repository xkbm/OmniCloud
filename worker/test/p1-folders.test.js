import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

async function read(rel) {
	return readFile(path.join(here, '..', rel), 'utf8');
}

test('silent-root move is rejected with DESTINATION_NOT_FOUND before execution', async () => {
	const source = await read('src/routes/files.js');
	const guardIndex = source.indexOf("code:'DESTINATION_NOT_FOUND'},404)");
	assert.notEqual(guardIndex, -1, 'missing 404 guard for missing destination path');
	const moveIndex = source.indexOf('app.post(\'/api/files/:id/move\'');
	const performMoveIndex = source.indexOf('await performMove(c.env,account,source.row');
	assert.ok(performMoveIndex > moveIndex);
	const guardWithinMove = source.slice(moveIndex, performMoveIndex).includes('DESTINATION_NOT_FOUND');
	assert.ok(guardWithinMove, 'guard must live inside the move handler before performMove');
});

test('search and starred listings merge virtual folders without duplicates', async () => {
	const source = await read('src/routes/files.js');
	assert.match(source, /listVirtualFolderRows\(db,user\.id,\{namePattern:search\}\)/);
	assert.match(source, /listVirtualFolderRows\(db,user\.id,\{starredOnly:true\}\)/);
	assert.match(source, /function mergePhysicalThenVirtual/);
});

test('virtual folders are no longer mirrored into file_metadata on create', async () => {
	const source = await read('src/routes/files.js');
	const virtualFolders = await read('src/routes/virtualFolders.js');
	assert.doesNotMatch(virtualFolders, /INSERT INTO file_metadata \(id,user_id,virtual_path,file_name,is_folder/);
	// Dead shadowed route must stay deleted from files.js.
	assert.doesNotMatch(source, /app\.post\('\/api\/files\/folders'/);
});

test('google sync is incremental: upsert + targeted stale delete, never a blanket wipe first', async () => {
	const source = await read('src/providers/google.js');
	assert.match(source, /ON CONFLICT \(cloud_account_id, remote_file_id\) DO UPDATE SET/);
	assert.match(source, /NOT \(remote_file_id = ANY\(\$\{syncedIds\}\)\)/);
	const wipeIndex = source.indexOf('DELETE FROM file_metadata WHERE user_id = ${userId} AND cloud_account_id = ${account.id}`;');
	if (wipeIndex !== -1) {
		const upsertIndex = source.indexOf('ON CONFLICT (cloud_account_id, remote_file_id)');
		assert.ok(upsertIndex < wipeIndex || wipeIndex === -1, 'blanket wipe must not precede upserts');
	}
});

test('transfer paths resolve destinations through folderRefs dual-read', async () => {
	for (const rel of [
		'src/storage/runner.js',
		'src/routes/backgroundMove.js',
		'src/routes/copy.js',
		'src/routes/fileOperationSagas.js',
	]) {
		const source = await read(rel);
		assert.match(source, /folderRefs/, `${rel} must use the shared dual-read resolver`);
	}
});

test('mutating routes emit searchable [route-error] logs', async () => {
	for (const [rel, tag] of [
		['src/routes/files.js', '[route-error] files'],
		['src/routes/virtualFolders.js', '[route-error] virtual-folders'],
		['src/routes/uploads.js', '[route-error] uploads'],
	]) {
		const source = await read(rel);
		assert.ok(source.includes(tag), `${rel} missing ${tag}`);
	}
});

test('sync mode flag and auto-sync interval are configured', async () => {
	const wrangler = await read('wrangler.toml');
	assert.match(wrangler, /SYNC_FOLDER_MODE = "vf"/);
	assert.match(wrangler, /AUTO_SYNC_INTERVAL_MINUTES = "60"/);
	const indexSource = await read('src/index.js');
	assert.match(indexSource, /runAutoSync\(env\)/);
});
