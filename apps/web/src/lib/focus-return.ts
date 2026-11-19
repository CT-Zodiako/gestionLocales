/**
 * Radix returns focus to a `Dialog.Trigger` on close; these dialogs are opened from a store (toolbar button, an empty
 * slot, an appointment block), so the opener is remembered by hand and focused again when the dialog closes.
 */
let opener: HTMLElement | null = null;

/** Call from the click handler that opens a dialog, with the clicked element (`event.currentTarget`). */
export function rememberOpener(element: HTMLElement): void {
  opener = element;
}

/** `onCloseAutoFocus` of the dialog content: back to the opener, or to the agenda when it is gone (a cancelled block). */
export function restoreOpener(event: Event): void {
  event.preventDefault();
  const target = opener?.isConnected ? opener : document.querySelector<HTMLElement>("main");
  opener = null;
  target?.focus();
}
