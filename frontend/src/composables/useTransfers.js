import { computed, onBeforeUnmount, ref } from 'vue';
import { api } from '../services/api.js';

const POLL_INTERVAL_MS = 2000;

export function useTransfers() {
  const transfers = ref([]);
  const loading = ref(false);
  const error = ref(null);
  let timer = null;

  const activeTransfers = computed(() => transfers.value.filter((job) => ['queued', 'running', 'paused', 'verifying'].includes(job.status)));

  function stopPolling() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function refresh(limit = 25) {
    loading.value = true;
    error.value = null;
    try {
      const response = await api.listTransfers(limit);
      transfers.value = Array.isArray(response?.data) ? response.data : [];
    } catch (err) {
      error.value = err;
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function refreshOne(jobId) {
    const response = await api.getTransfer(jobId);
    const job = response?.data;
    if (!job) return null;
    const index = transfers.value.findIndex((item) => item.id === job.id);
    if (index >= 0) transfers.value[index] = job;
    else transfers.value.unshift(job);
    return job;
  }

  async function cancel(jobId) {
    const response = await api.cancelTransfer(jobId);
    const job = response?.data;
    if (job) {
      const index = transfers.value.findIndex((item) => item.id === job.id);
      if (index >= 0) transfers.value[index] = job;
    }
    return job;
  }

  function startPolling() {
    if (timer) return;
    timer = setInterval(async () => {
      try {
        await refresh();
        if (!activeTransfers.value.length) stopPolling();
      } catch {
        // Keep the polling loop alive; the next cycle retries.
      }
    }, POLL_INTERVAL_MS);
  }

  async function watchJob(jobId) {
    stopPolling();
    await refreshOne(jobId);
    if (activeTransfers.value.some((job) => job.id === jobId)) startPolling();
  }

  onBeforeUnmount(stopPolling);

  return {
    transfers,
    activeTransfers,
    loading,
    error,
    refresh,
    refreshOne,
    cancel,
    watchJob,
    startPolling,
    stopPolling,
  };
}
