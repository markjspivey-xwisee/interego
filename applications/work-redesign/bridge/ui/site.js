// The landing page's and the guide's one script. Their menu (#site-menu, the header's section links below 64em) is a
// popover the header's button opens with no script; choosing one of its links leaves it open, over the very section the
// link went to. Here it closes once a link in it is chosen, by click, tap or key. A click that opens the link elsewhere
// (with a modifier key or another button) leaves it as it is. Nothing else runs here.
const menu = document.getElementById('site-menu');
menu?.addEventListener('click', (e) => {
  if (!(e.target instanceof Element) || !e.target.closest('a[href]')) return;
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  try { menu.hidePopover?.(); } catch { /* already closed, or a browser without popovers */ }
});
