// Practice Evidence help page: shows this workspace's address and offers to copy it. Text only; nothing is parsed as markup.
const out = document.getElementById('workspace-address');
const copy = document.getElementById('copy-workspace-address');
if (out) {
  const address = new URL('../', location.href).href;
  out.textContent = address;
  if (copy && navigator.clipboard) {
    copy.hidden = false;
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(address).then(() => { copy.textContent = 'Copied'; }, () => { copy.textContent = 'Select the address to copy it'; });
    });
  }
}
