// The embedded App routes without navigating its sandbox document. The ordinary
// Site keeps native fragment history, including browser Back/Forward events.
const fragment = value => value.startsWith("#") ? value : "#" + value;
const readHash = (host, fallback = "#home") => {
  try { return host?.location?.hash || "#home"; } catch { return fallback; }
};

export function createNavigation(host) {
  let current = readHash(host);
  const subscribers = new Set();
  const appMode = () => !!host?.__I2IDLX_CHATGPT_APP__;
  const publish = value => {
    current = fragment(value);
    // Repeating the current route still refreshes route consumers.
    for (const subscriber of subscribers) subscriber(current);
  };
  const onHashChange = () => {
    if (!appMode()) publish(readHash(host, current));
  };
  return {
    getHash: () => appMode() ? current : readHash(host, current),
    subscribe(subscriber) {
      if (!subscribers.size) host?.addEventListener?.("hashchange", onHashChange);
      subscribers.add(subscriber);
      subscriber(appMode() ? current : readHash(host, current));
      return () => {
        subscribers.delete(subscriber);
        if (!subscribers.size) host?.removeEventListener?.("hashchange", onHashChange);
      };
    },
    go(value) {
      const next = fragment(value);
      if (appMode()) { publish(next); return; }
      if (readHash(host, current) !== next) {
        host.location.hash = next;
      } else {
        // Preserve the Site's existing same-fragment notification behavior.
        host.dispatchEvent(new host.HashChangeEvent("hashchange"));
      }
    },
  };
}

// Install on document in the bubble phase, after React's root handlers. React
// controls that already prevented a link's default behavior retain ownership.
export function installFragmentNavigation(doc, navigate) {
  const onClick = event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target?.nodeType === 3 ? event.target.parentElement : event.target;
    const anchor = target?.closest?.("a[href]");
    if (!anchor || anchor.hasAttribute("download")) return;
    const href = anchor.getAttribute("href");
    const destination = anchor.getAttribute("target");
    if (!href?.startsWith("#") || (destination && destination.toLowerCase() !== "_self")) return;
    event.preventDefault();
    navigate(href);
  };
  doc.addEventListener("click", onClick);
  return () => doc.removeEventListener("click", onClick);
}
