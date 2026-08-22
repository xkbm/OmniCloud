<script setup>
import { computed, ref } from 'vue';
import { IconStarFilled } from '@tabler/icons-vue';
import TruncateMarquee from './TruncateMarquee.vue';
import { formatBytes, formatDate, getModifiedTime } from '../composables/useFormatFile.js';
import { getFileIcon } from '../composables/useFileType.js';
import '../utils/internalDragGuard.js';
import { isCoarsePointerDevice } from '../utils/touchDevice.js';

const props = defineProps({
  item: { type: Object, required: true },
  selected: { type: Boolean, default: false },
  nameField: { type: String, default: 'file_name' },
  showStar: { type: Boolean, default: true },
  highlighted: { type: Boolean, default: false },
  selectionActive: { type: Boolean, default: false },
});

const emit = defineEmits(['select', 'open', 'contextmenu']);
const isDragging = ref(false);
const isDropTarget = ref(false);
const dragMime = 'application/x-omnicloud-file';
const selectionMime = 'application/x-omnicloud-selection';

const displayName = computed(() => {
  if (props.nameField === 'display_name') return props.item.display_name || props.item.file_name || '';
  return props.item[props.nameField] || '';
});

const canDrag = computed(() => props.item?.capabilities?.move !== false);
const canDrop = computed(() => props.item.is_folder && props.item?.capabilities?.move !== false);
const isInternalDrag = (event) => Boolean(event.dataTransfer?.types?.includes(dragMime));

function handleDblClick(event) { emit('open', event); }
function handleContextMenu(event) { emit('contextmenu', event); }

// Touch: tap opens, long-press (500ms) selects + opens the context menu.
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;
let pressTimer = null;
let pressStartX = 0;
let pressStartY = 0;
let suppressNextClick = false;

function isTouchPointer(event) {
  return isCoarsePointerDevice() && (event.pointerType === 'touch' || event.pointerType === 'pen');
}

function clearPressTimer() {
  if (pressTimer !== null) { window.clearTimeout(pressTimer); pressTimer = null; }
}

function handlePressStart(event) {
  if (!isTouchPointer(event)) return;
  clearPressTimer();
  pressStartX = event.clientX;
  pressStartY = event.clientY;
  pressTimer = window.setTimeout(() => {
    pressTimer = null;
    suppressNextClick = true;
    try { navigator.vibrate?.(20); } catch {}
    if (!props.selected) emit('select', event);
    handleContextMenu(event);
  }, LONG_PRESS_MS);
}

function handlePressMove(event) {
  if (!pressTimer) return;
  if (Math.abs(event.clientX - pressStartX) > LONG_PRESS_SLOP_PX || Math.abs(event.clientY - pressStartY) > LONG_PRESS_SLOP_PX) clearPressTimer();
}

function handleClick(event) {
  if (suppressNextClick) { suppressNextClick = false; return; }
  if (isCoarsePointerDevice()) {
    if (props.selectionActive) { emit('select', event); return; }
    emit('open', event);
    return;
  }
  emit('select', event);
}

function handleDragStart(event) {
  if (!canDrag.value) return;
  isDragging.value = true;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData(dragMime, props.item.id);
  event.dataTransfer.setData(selectionMime, props.selected ? '1' : '0');
  event.dataTransfer.setData('text/plain', props.item.file_name || '');
}

function handleDragEnd() {
  isDragging.value = false;
  isDropTarget.value = false;
}

function handleDragEnter(event) {
  if (!isInternalDrag(event)) return;
  event.stopPropagation();
  if (!canDrop.value) return;
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  event.preventDefault();
  isDropTarget.value = true;
}

function handleDragOver(event) {
  if (!isInternalDrag(event)) return;
  event.stopPropagation();
  if (!canDrop.value) return;
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  event.preventDefault();
  isDropTarget.value = true;
}

function handleDragLeave(event) {
  if (!isInternalDrag(event)) return;
  event.stopPropagation();
  if (!event.currentTarget.contains(event.relatedTarget)) isDropTarget.value = false;
}

function handleDrop(event) {
  if (!isInternalDrag(event)) return;
  event.stopPropagation();
  if (!canDrop.value) return;
  event.preventDefault();
  isDropTarget.value = false;

  const sourceFileId = event.dataTransfer.getData(dragMime);
  if (!sourceFileId || sourceFileId === props.item.id) return;

  window.dispatchEvent(new CustomEvent('omnicloud:drag-move', {
    detail: {
      sourceFileId,
      targetFolder: props.item,
      sourceWasSelected: event.dataTransfer.getData(selectionMime) === '1',
    },
  }));
}
</script>

<template>
  <div
    class="group grid min-h-[52px] cursor-default select-none grid-cols-[minmax(260px,2fr)_minmax(150px,1fr)_140px] items-center gap-3 border-t border-[#eceff1] px-[18px] transition first:border-t-0 dark:border-slate-700 max-md:grid-cols-[minmax(0,1fr)_90px]"
    :class="[
      selected ? 'bg-gradient-to-r from-[#e8f0fe] to-[#f8fbff] shadow-[inset_4px_0_0_#1a73e8] dark:from-sky-500/15 dark:to-slate-800 dark:shadow-[inset_4px_0_0_#38bdf8]' : isDropTarget ? 'bg-gradient-to-r from-sky-50 to-[#f7fbff] shadow-[inset_4px_0_0_#0ea5e9] ring-2 ring-inset ring-sky-400/70 dark:from-sky-400/15 dark:to-slate-800 dark:shadow-[inset_4px_0_0_#38bdf8]' : highlighted ? 'bg-gradient-to-r from-amber-50 to-[#fffdf5] shadow-[inset_4px_0_0_#f59e0b] dark:from-amber-400/15 dark:to-slate-800 dark:shadow-[inset_4px_0_0_#fbbf24]' : 'hover:bg-black/[0.02] dark:hover:bg-white/6',
      isDragging ? 'opacity-45' : '',
    ]"
    :data-file-id="item.id"
    :draggable="canDrag"
    @dragstart="handleDragStart"
    @dragend="handleDragEnd"
    @dragenter="handleDragEnter"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
    @pointerdown="handlePressStart"
    @pointermove="handlePressMove"
    @pointerup="clearPressTimer"
    @pointercancel="clearPressTimer"
    @pointerleave="clearPressTimer"
    @click="handleClick"
    @dblclick="handleDblClick"
    @contextmenu="handleContextMenu"
  >
    <div class="flex min-w-0 items-center gap-2.5 text-[#202124] dark:text-slate-100">
      <component :is="getFileIcon(item, selected || highlighted || isDropTarget)" :size="18" :stroke="selected || highlighted || isDropTarget ? 0 : 1.8" class="transition-transform duration-200 group-hover:scale-110" :class="selected ? 'text-[#1a73e8] drop-shadow-sm dark:text-sky-300' : isDropTarget ? 'text-sky-500 drop-shadow-sm dark:text-sky-300' : highlighted ? 'text-amber-500 drop-shadow-sm dark:text-amber-300' : 'text-[#5f6368] dark:text-slate-400'" />
      <TruncateMarquee :text="displayName" />
      <IconStarFilled v-if="showStar && item.is_starred && item.capabilities?.starred" :size="14" :stroke="0" class="shrink-0 text-amber-400" />
    </div>
    <span class="text-[#5f6368] dark:text-slate-400 max-md:hidden">{{ formatDate(getModifiedTime(item)) }}</span>
    <span class="text-[#5f6368] dark:text-slate-400">{{ item.is_folder ? '—' : formatBytes(item.size) }}</span>
  </div>
</template>
