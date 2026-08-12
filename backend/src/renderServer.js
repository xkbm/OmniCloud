import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { LOCAL_USER_ID } from './config/database.js';
import { registerUploadSocket, unregisterUploadSocket } from './services/websocketHub.js';
import { runDeltaSync, scheduleSync } from './services/syncService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDist = path.resolve(__dirname, '../../frontend/dist');

const app = createApp();

app.use(express.static(frontendDist));

app.use((req, res, next) => {
	if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/ws')) {
		return next();
	}

	return res.sendFile(path.join(frontendDist, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/uploads' });

wss.on('connection', (socket, request) => {
	const url = new URL(request.url, `http://${request.headers.host}`);
	const uploadId = url.searchParams.get('uploadId');

	if (!uploadId) {
		socket.close(1008, 'uploadId is required');
		return;
	}

	registerUploadSocket(uploadId, socket);

	socket.send(
		JSON.stringify({
			type: 'socket:ready',
			uploadId,
			status: 'connected',
		}),
	);

	socket.on('close', () => {
		unregisterUploadSocket(uploadId, socket);
	});
});

scheduleSync();

if (env.appMode === 'local') {
	runDeltaSync(LOCAL_USER_ID).catch((error) => {
		console.error('Initial sync failed:', error);
	});
}

server.listen(env.port, '0.0.0.0', () => {
	console.log(`OmniCloud listening on ${env.port}`);
});
