const INTERNAL_DRAG_MIME = 'application/x-omnicloud-file';

function isInternalDrag(event) {
  return Boolean(event?.dataTransfer?.types?.includes(INTERNAL_DRAG_MIME));
}

function isFileTarget(event) {
  return Boolean(event?.target?.closest?.('[data-file-id]'));
}

if (typeof document !== 'undefined') {
  for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    document.addEventListener(type, (event) => {
      if (!isInternalDrag(event) || isFileTarget(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }, true);
  }
}
