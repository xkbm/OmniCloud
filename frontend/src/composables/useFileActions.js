import { computed, onBeforeUnmount, onMounted } from 'vue';
import { api } from '../services/api';
import { useContextMenu } from './useContextMenu';
import { useFileSelection } from './useFileSelection';
import { useFilePreviewModal } from './useFilePreviewModal';
import { useFileDetailsModal } from './useFileDetailsModal';

const MOVABLE_PROVIDERS = new Set(['google_drive', 'onedrive', 'dropbox', 'yandex', 's3', 'mega', 'pcloud']);
const TRANSFER_POLL_INTERVAL_MS = 2000;
const TRANSFER_POLL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export function useFileActions({
  sourceList,
  errorRef,
  t,
  getFileCategory,
  uploadQueueStore,
  refresh,
  getPreviewType,
  previewUnsupportedMessage = 'Preview belum didukung untuk tipe file ini.',
  onProgress,
  onTransferProgress,
}) {
  if (!errorRef || typeof t !== 'function' || typeof getFileCategory !== 'function' || !uploadQueueStore || typeof refresh !== 'function') {
    throw new Error('useFileActions: required options missing');
  }

  const runWithProgress = (label, task) => (typeof onProgress === 'function'
    ? onProgress(label, task)
    : task());

  const { contextMenu, contextMenuRef, closeContextMenu, openContextMenu: openContextMenuBase } = useContextMenu();

  const {
    previewFile,
    isPreviewOpen,
    isPreviewLoading,
    canPreview,
    openPreview,
    closePreview,
    handlePreviewLoaded,
    handlePreviewFailed,
  } = useFilePreviewModal({
    getFileCategory,
    buildPreviewUrl: (file) => api.previewUrl(file.id),
    getPreviewType,
    onUnsupported: () => {
      closeContextMenu();
      errorRef.value = previewUnsupportedMessage;
    },
  });

  const {
    detailsFile,
    isDetailsOpen,
    openDetails,
    closeDetails,
  } = useFileDetailsModal({
    fetchDetails: (file) => api.getFileDetails(file.id),
    onError: (error) => {
      errorRef.value = error.message;
    },
  });

  const {
    selectedFileIds,
    lastSelectedFileId,
    selectedFiles,
    selectedCount,
    primarySelectedFile,
    isSelected,
    replaceSelection,
    toggleSelection,
    selectRange,
    selectItem,
    clearSelection,
  } = useFileSelection({ sourceList, onBeforeSelect: closeContextMenu });

  const canDownloadSelection = computed(() => selectedFiles.value.some((file) => !file.is_folder));
  const canRenameSelection = computed(() => selectedCount.value === 1 && primarySelectedFile.value?.capabilities?.rename !== false);
  const canToggleStarSelection = computed(() => {
    if (selectedCount.value !== 1) return false;
    const file = primarySelectedFile.value;
    return Boolean(file && file.capabilities?.starred);
  });
  const isPrimarySelectedStarred = computed(() => Boolean(primarySelectedFile.value?.is_starred));
  const canOpenSelection = computed(() => selectedCount.value === 1 && Boolean(primarySelectedFile.value?.is_folder));
  const canPreviewSelection = computed(() => selectedCount.value === 1 && canPreview(primarySelectedFile.value));
  const canMoveSelection = computed(
    () => selectedCount.value >= 1 && selectedFiles.value.every((file) => MOVABLE_PROVIDERS.has(file?.provider)),
  );

  function getActionFiles(fallbackFile = contextMenu.value.file) {
    return selectedFiles.value.length ? selectedFiles.value : (fallbackFile ? [fallbackFile] : []);
  }

  async function waitForTransferJob(jobId) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < TRANSFER_POLL_TIMEOUT_MS) {
      const response = await api.getTransfer(jobId);
      const job = response?.data;
      if (!job) throw new Error('Transfer job not found');

      const totalBytes = Number(job.bytes_total || 0);
      const completedBytes = Number(job.bytes_completed || 0);
      const totalNodes = Number(job.total_nodes || 0);
      const completedNodes = Number(job.completed_nodes || 0);
      const percent = totalBytes > 0
        ? Math.min(100, Math.round((completedBytes / totalBytes) * 100))
        : totalNodes > 0
          ? Math.min(100, Math.round((completedNodes / totalNodes) * 100))
          : 0;

      if (typeof onTransferProgress === 'function') {
        onTransferProgress({ job, percent, completedBytes, totalBytes, completedNodes, totalNodes });
      }

      if (job.status === 'completed') return job;
      if (job.status === 'failed') throw new Error(job.error_message || 'Transfer failed');
      if (job.status === 'cancelled') throw new Error('Transfer cancelled');

      await new Promise((resolve) => window.setTimeout(resolve, TRANSFER_POLL_INTERVAL_MS));
    }

    throw new Error('Transfer is taking longer than expected. You can check its progress from the transfer status.');
  }

  async function moveTargetToFolder(target, targetFolder) {
    const response = await api.moveFile(target.id, { target_folder_id: targetFolder.id });
    const transferJobId = response?.data?.transferJobId;
    if (transferJobId) await waitForTransferJob(transferJobId);
    return response;
  }

  async function moveTargetToPath(target, virtualPath) {
    const response = await api.moveFile(target.id, { virtual_path: virtualPath });
    const transferJobId = response?.data?.transferJobId;
    if (transferJobId) await waitForTransferJob(transferJobId);
    return response;
  }

  function openContextMenu(event, file) {
    if (!selectedFileIds.value.has(file.id)) replaceSelection(file);
    return openContextMenuBase(event, file);
  }

  function resolveFile() {
    return primarySelectedFile.value || contextMenu.value.file;
  }

  async function showSelectedFileDetails() {
    const file = resolveFile();
    if (!file) return;
    closeContextMenu();
    errorRef.value = '';
    await openDetails(file);
  }

  async function renameSelectedFile({ trackServerOperation } = {}) {
    const file = resolveFile();
    if (!file) return;
    const nextName = window.prompt(t('drive.newNamePrompt'), file.file_name);
    closeContextMenu();
    if (!nextName?.trim() || nextName.trim() === file.file_name) return;
    errorRef.value = '';
    try {
      const task = () => (typeof trackServerOperation === 'function'
        ? trackServerOperation(file, nextName.trim())
        : api.renameFile(file.id, { name: nextName.trim() }));
      await runWithProgress(t('upload.renaming'), task);
      await refresh();
    } catch (error) {
      errorRef.value = error.message;
    }
  }

  async function deleteSelectedFile({ trackServerOperation } = {}) {
    const targets = getActionFiles();
    if (!targets.length) return;
    const message = targets.length === 1
      ? t('drive.deleteConfirm', { name: targets[0].file_name })
      : t('drive.deleteConfirm', { name: `${targets.length} ${t('common.items')}` });
    const confirmed = window.confirm(message);
    closeContextMenu();
    if (!confirmed) return;
    errorRef.value = '';
    try {
      const task = () => {
        if (targets.length === 1) {
          const target = targets[0];
          if (typeof trackServerOperation === 'function') return trackServerOperation(target);
          return api.deleteFile(target.id);
        }
        if (typeof trackServerOperation === 'function') return trackServerOperation(targets);
        return api.deleteFiles(targets.map((file) => file.id));
      };
      await runWithProgress(t('upload.deleting'), task);
      clearSelection();
      await refresh();
    } catch (error) {
      errorRef.value = error.message;
    }
  }

  async function moveFilesToFolder(targets, targetFolder) {
    if (!targets.length || !targetFolder?.is_folder) return;
    if (!MOVABLE_PROVIDERS.has(targetFolder.provider)) {
      errorRef.value = 'Esta carpeta todavía no admite almacenamiento unificado.';
      return;
    }
    const invalid = targets.find((file) => !MOVABLE_PROVIDERS.has(file?.provider));
    if (invalid) {
      errorRef.value = 'Uno de los elementos seleccionados no admite movimiento.';
      return;
    }

    errorRef.value = '';
    await runWithProgress(
      targets.length > 1 ? `Moviendo ${targets.length} elementos` : 'Moviendo',
      async () => {
        for (const target of targets) {
          await moveTargetToFolder(target, targetFolder);
        }
      },
    );
    clearSelection();
    await refresh();
  }

  async function moveFilesToPath(targets, virtualPath) {
    if (!targets.length) return;
    const invalid = targets.find((file) => !MOVABLE_PROVIDERS.has(file?.provider));
    if (invalid) {
      errorRef.value = 'Uno de los elementos seleccionados no admite movimiento.';
      return;
    }
    errorRef.value = '';
    await runWithProgress(
      targets.length > 1 ? `Moviendo ${targets.length} elementos` : 'Moviendo',
      async () => {
        for (const target of targets) await moveTargetToPath(target, virtualPath);
      },
    );
    clearSelection();
    await refresh();
  }

  async function moveSelectedFile() {
    const targets = getActionFiles();
    if (!targets.length) return;
    if (!canMoveSelection.value) {
      errorRef.value = 'Uno de los elementos seleccionados no admite movimiento.';
      closeContextMenu();
      return;
    }
    const destination = window.prompt('Ruta de destino (usa / para la raíz):', '/');
    if (destination === null) return;
    const virtualPath = destination.trim() || '/';
    closeContextMenu();
    try {
      await moveFilesToPath(targets, virtualPath);
    } catch (error) {
      errorRef.value = error.message;
    }
  }

  async function handleDragMoveEvent(event) {
    const detail = event.detail || {};
    const sourceFileId = detail.sourceFileId;
    const targetFolder = detail.targetFolder;
    if (!sourceFileId || !targetFolder?.is_folder) return;

    const files = sourceList?.value || sourceList || [];
    const sourceFile = files.find?.((file) => file.id === sourceFileId) || null;
    if (!sourceFile) {
      errorRef.value = 'No se pudo identificar el archivo arrastrado.';
      return;
    }

    const targets = detail.sourceWasSelected && selectedFileIds.value.has(sourceFile.id)
      ? selectedFiles.value
      : [sourceFile];

    try {
      closeContextMenu();
      await moveFilesToFolder(targets, targetFolder);
    } catch (error) {
      errorRef.value = error.message;
    }
  }

  async function toggleSelectedFileStar() {
    const file = resolveFile();
    if (!file || !file.capabilities?.starred) return;
    closeContextMenu();
    errorRef.value = '';
    try {
      await runWithProgress(
        file.is_starred ? t('drive.removingStar') : t('drive.addingStar'),
        () => api.toggleStar(file.id, !file.is_starred),
      );
      await refresh();
    } catch (error) {
      errorRef.value = error.message;
    }
  }

  function handleWindowPointerDown(event) {
    if (!event.target.closest('[data-context-menu]')) closeContextMenu();
  }

  onMounted(() => window.addEventListener('pointerdown', handleWindowPointerDown));
  onBeforeUnmount(() => window.removeEventListener('pointerdown', handleWindowPointerDown));
  onMounted(() => window.addEventListener('omnicloud:drag-move', handleDragMoveEvent));
  onBeforeUnmount(() => window.removeEventListener('omnicloud:drag-move', handleDragMoveEvent));

  return {
    contextMenu,
    contextMenuRef,
    closeContextMenu,
    openContextMenu,
    selectedFileIds,
    lastSelectedFileId,
    selectedFiles,
    selectedCount,
    primarySelectedFile,
    isSelected,
    replaceSelection,
    toggleSelection,
    selectRange,
    selectItem,
    clearSelection,
    canDownloadSelection,
    canRenameSelection,
    canToggleStarSelection,
    isPrimarySelectedStarred,
    canOpenSelection,
    canPreviewSelection,
    canMoveSelection,
    previewFile,
    isPreviewOpen,
    isPreviewLoading,
    canPreview,
    openPreview,
    closePreview,
    handlePreviewLoaded,
    handlePreviewFailed,
    detailsFile,
    isDetailsOpen,
    openDetails,
    closeDetails,
    showSelectedFileDetails,
    renameSelectedFile,
    deleteSelectedFile,
    moveSelectedFile,
    toggleSelectedFileStar,
    moveFilesToFolder,
    moveFilesToPath,
    actionInProgress: undefined,
    actionLabel: undefined,
  };
}
