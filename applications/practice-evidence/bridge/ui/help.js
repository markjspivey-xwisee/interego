// Practice Evidence help page: shows this workspace's addresses and offers to copy them. Text only; nothing is parsed as markup.
function showAddress(outId, copyId, path) {
  const out = document.getElementById(outId);
  const copy = document.getElementById(copyId);
  if (!out) return;
  const address = new URL(path, location.href).href;
  out.textContent = address;
  if (copy && navigator.clipboard) {
    copy.hidden = false;
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(address).then(() => { copy.textContent = 'Copied'; }, () => { copy.textContent = 'Select the address to copy it'; });
    });
  }
}
showAddress('workspace-address', 'copy-workspace-address', '../');
// The MCP endpoint answers an MCP client, not a browser, so it is shown to copy rather than linked.
showAddress('mcp-address', 'copy-mcp-address', '../mcp');
