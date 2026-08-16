import { defineStore } from 'pinia';
import { api } from '../services/api';

function normalizePath(path) {
	if (!path || path === '/') return '/';
	const prefixed = path.startsWith('/') ? path : `/${path}`;
	return prefixed.endsWith('/') ? prefixed : `${prefixed}/`;
}

function buildVirtualPath(currentPath, relativePath = '') {
	const normalizedCurrent = normalizePath(currentPath);
	if (!relativePath) return normalizedCurrent;

	const segments = relativePath.split('/').filter(Boolean);
	segments.pop();

	if (!segments.length) return normalizedCurrent;
	return normalizePath(`${normalizedCurrent}${segments.join('/')}`);
}

function normalizeUploadEntry(entry) {
	if (entry instanceof File) {
		return {
			file: entry,
			relativePath: entry.webkitRelativePath || entry.name,
		};
	}

	return {
		file: entry.file,
		relativePath: entry.relativePath || entry.file?.webkitRelativePath || entry.file?.name,
	};
}

function isAbortError(error) {
	return error?.name === 'AbortError';
}

function isCancellable(operation) {
	return ['upload', 'download'].includes(operation?.type) && ['pending', 'uploading', 'downloading'].includes(operation?.status);
}

function createBatchId() {
	return crypto.randomUUID();
}

function calculateBatchProgress(items) {
	if (!items.length) return 0;

	const totalBytes = items.reduce((sum, item) => sum + Math.max(0, Number(item.size) || 0), 0);
	if (totalBytes > 0) {
		const transferredBytes = items.reduce((sum, item) => {
			const size = Math.max(0, Number(item.size) || 0);
			const progress = Math.min(100, Math.max(0, Number(item.progress_percentage) || 0));
			return sum + (size * progress) / 100;
		}, 0);
		return Math.round((transferredBytes / totalBytes) * 100);
	}

	return Math.round(
		items.reduce((sum, item) => sum + Math.min(100, Math.max(0, Number(item.progress_percentage) || 0)), 0) / items.length,
	);
}

export const useUploadQueueStore = defineStore('uploadQueue', {
	state: () => ({
		uploads: [],
	}),
	getters: {
		activeUploads: (state) => state.uploads.filter((item) => !['completed', 'failed', 'cancelled'].includes(item.status)),
		totalProgress: (state) => {
			const activeItems = state.uploads.filter((item) => !['completed', 'failed', 'cancelled'].includes(item.status));
			if (!activeItems.length) return 0;

			const latestBatchId = activeItems.find((item) => item.batchId)?.batchId;
			const batchItems = latestBatchId
				? state.uploads.filter((item) => item.batchId === latestBatchId)
				: activeItems;

			return calculateBatchProgress(batchItems);
		},
	},
	actions: {
		registerOperation({ type, name, size = 0, status = 'pending', progress = 0, ...metadata }) {
			const operation = {
				id: crypto.randomUUID(),
				type,
				name,
				...metadata,
				size,
				progress_percentage: progress,
				status,
				error: null,
				createdAt: Date.now(),
			};

			this.uploads.unshift(operation);
			return operation;
		},
		registerUpload(file, currentPath, relativePath, metadata = {}) {
			const abortController = new AbortController();
			const upload = {
				id: crypto.randomUUID(),
				type: 'upload',
				file,
				name: relativePath || file.name,
				...metadata,
				size: file.size,
				progress_percentage: 0,
				status: 'pending',
				socket: null,
				abortController,
				currentPath,
				error: null,
			};

			this.uploads.unshift(upload);
			return upload;
		},
		updateUpload(id, patch) {
			const index = this.uploads.findIndex((item) => item.id === id);
			if (index === -1) return;
			this.uploads[index] = { ...this.uploads[index], ...patch };
		},
		closeOperation(id) {
			const operation = this.uploads.find((item) => item.id === id);
			const batchOperations = operation ? [] : this.uploads.filter((item) => item.batchId === id);

			if (batchOperations.length) {
				const hasCancellable = batchOperations.some((item) => isCancellable(item));
				if (hasCancellable) {
					for (const item of batchOperations) {
						item.abortController?.abort?.();
						item.socket?.close?.();
						this.updateUpload(item.id, { status: 'cancelled', error: null });
					}
					return;
				}

				for (const item of batchOperations) item.socket?.close?.();
				this.uploads = this.uploads.filter((item) => item.batchId !== id);
				return;
			}

			if (isCancellable(operation)) {
				operation.abortController?.abort?.();
				operation.socket?.close?.();
				this.updateUpload(id, { status: 'cancelled', error: null });
				return;
			}

			operation?.socket?.close?.();
			this.uploads = this.uploads.filter((item) => item.id !== id);
		},
		clearOperations() {
			for (const operation of this.uploads) {
				operation.abortController?.abort?.();
				operation.socket?.close?.();
			}
			this.uploads = [];
		},
		async trackServerOperation(metadata, operation) {
			const queueItem = this.registerOperation({ ...metadata, status: 'processing', progress: 15 });
			try {
				this.updateUpload(queueItem.id, { progress_percentage: 45 });
				const result = await operation();
				this.updateUpload(queueItem.id, { progress_percentage: 100, status: 'completed' });
				return result;
			} catch (error) {
				this.updateUpload(queueItem.id, { status: 'failed', error: error.message });
				throw error;
			}
		},
		async downloadFile(file) {
			return this.downloadFiles(file ? [file] : []);
		},
		async downloadFiles(files) {
			const downloadableFiles = files.filter((file) => file && !file.is_folder);
			if (!downloadableFiles.length) return;

			const batchId = createBatchId();
			const batchTotal = downloadableFiles.length;

			for (const file of downloadableFiles) {
				const abortController = new AbortController();
				const queueItem = this.registerOperation({
					type: 'download',
					name: file.display_name || file.file_name,
					size: file.size || 0,
					status: 'downloading',
					abortController,
					batchId,
					batchTotal,
				});

				try {
					const response = await fetch(api.downloadUrl(file.id), { signal: abortController.signal });
					if (!response.ok) {
						const payload = await response.json().catch(() => ({ error: 'Download failed' }));
						throw new Error(payload.error || 'Download failed');
					}

					const contentLength = Number(response.headers.get('Content-Length')) || file.size || 0;
					const reader = response.body?.getReader();
					const chunks = [];
					let received = 0;

					if (reader) {
						while (true) {
							if (abortController.signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
							const { done, value } = await reader.read();
							if (done) break;
							chunks.push(value);
							received += value.length;
							const percent = contentLength ? Math.min(99, Math.round((received / contentLength) * 100)) : 50;
							this.updateUpload(queueItem.id, { progress_percentage: percent });
						}
					} else {
						chunks.push(await response.blob());
					}

					const blob = chunks[0] instanceof Blob ? chunks[0] : new Blob(chunks);
					const url = URL.createObjectURL(blob);
					const link = document.createElement('a');
					link.href = url;
					link.download = file.display_name || file.file_name || 'download';
					document.body.appendChild(link);
					link.click();
					link.remove();
					URL.revokeObjectURL(url);
					this.updateUpload(queueItem.id, { progress_percentage: 100, status: 'completed' });
				} catch (error) {
					if (isAbortError(error)) {
						this.updateUpload(queueItem.id, { status: 'cancelled', error: null });
						return;
					}
					this.updateUpload(queueItem.id, { status: 'failed', error: error.message });
					if (batchTotal === 1) throw error;
				}
			}
		},
		async uploadFiles(files, currentPath, onCompleted) {
			const entries = Array.from(files || []);
			const batchId = createBatchId();
			const batchTotal = entries.length;

			for (const rawEntry of entries) {
				const { file, relativePath } = normalizeUploadEntry(rawEntry);
				if (!(file instanceof File)) continue;

				const queueItem = this.registerUpload(file, currentPath, relativePath, { batchId, batchTotal });
				const targetPath = buildVirtualPath(currentPath, relativePath);

				try {
					const { data } = await api.initiateUpload({
						file_name: file.name,
						size: file.size,
						mime_type: file.type || 'application/octet-stream',
						virtual_path: targetPath,
					}, { signal: queueItem.abortController.signal });

					const uploadId = data?.upload_id || data?.id;
					if (!uploadId) throw new Error('Upload session was not created');

					// WebSocket progress is optional. Cloudflare Pages may not proxy
					// upgrade requests on the same route, so never make the upload
					// depend on it. The actual file transfer is plain HTTP below.
					this.updateUpload(queueItem.id, {
						status: 'uploading',
						remoteUploadId: uploadId,
						progress_percentage: 1,
					});

					await api.uploadFile(uploadId, file, { signal: queueItem.abortController.signal });

					this.updateUpload(queueItem.id, {
						progress_percentage: 100,
						status: 'completed',
					});
					onCompleted?.();
				} catch (error) {
					if (isAbortError(error) || queueItem.abortController.signal.aborted) {
						this.updateUpload(queueItem.id, { status: 'cancelled', error: null });
						continue;
					}

					this.updateUpload(queueItem.id, { status: 'failed', error: error.message });
				}
			}
		},
	},
});
