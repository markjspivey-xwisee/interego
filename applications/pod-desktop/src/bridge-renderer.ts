import type { DesktopApi, PodStatus } from './types.js';
import type { AgentPermission } from './agent-types.js';
import type { BridgeClient, BridgePendingApproval, BridgeStatus } from './bridge-types.js';

interface BridgeUiContext {
  pod(): PodStatus | null;
  locallyBusy(): boolean;
  openDialog(dialog: HTMLDialogElement): void;
  closeDialog(dialog: HTMLDialogElement): void;
  showConnections(): void;
  onAccessChanged(): void;
}

const CLIENTS: Record<BridgeClient, string> = {
  'chatgpt-web': 'ChatGPT web', 'grok-bot': 'Grok Bot', 'other-web': 'Another web assistant',
};
const scopes = (permissions: readonly AgentPermission[]): string => permissions.map(value =>
  value === 'notes:read' ? 'Read all current and future notes' : 'Save new notes').join(' · ');
const date = (value: string): string => Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Unavailable';

/** Owner controls only. URLs are copied by the main process; no credentials enter this page. */
export function installBridgeUi(api: DesktopApi, context: BridgeUiContext): {
  refresh(): Promise<void>;
  updateAvailability(): void;
  isWebConnection(id: string): boolean;
  openSetup(): void;
} {
  const element = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing bridge element: ${id}`);
    return found as T;
  };
  const button = (id: string) => element<HTMLButtonElement>(id);
  const input = (id: string) => element<HTMLInputElement>(id);
  const dialog = element<HTMLDialogElement>('bridge-dialog');
  const form = element<HTMLFormElement>('bridge-form');
  let bridge: BridgeStatus | undefined;
  let unknown = true;
  let checked = false;
  let changing: string | null = null;
  let epoch = 0;
  let read = 0;
  let pendingSignature = '';
  let connectionsSignature = '';
  let previousClient: BridgeClient = 'chatgpt-web';
  let connectionState = '';
  const seenConnections = new Set<string>();
  const acknowledged = new Map<string, string>();
  const live = () => bridge?.state === 'ready' && !unknown && changing === null;
  const mayStart = () => !!context.pod()?.configured && !!context.pod()?.running
    && !context.pod()?.restorePending && !context.locallyBusy() && !unknown && changing === null
    && (bridge?.state === 'off' || bridge?.state === 'error');

  function message(text: string, error = false): void {
    const region = element('bridge-message');
    region.hidden = !text; region.textContent = text;
    region.classList.toggle('error', error);
    region.setAttribute('role', error ? 'alert' : 'status');
    const inline = element('bridge-dialog-message');
    inline.hidden = !text; inline.textContent = text;
    inline.classList.toggle('error', error);
    inline.setAttribute('role', error ? 'alert' : 'status');
  }

  function review(): void {
    if (dialog.open) context.closeDialog(dialog);
    context.showConnections();
    element('bridge-approval-heading').focus();
  }

  async function refresh(): Promise<void> {
    if (changing) return;
    const requested = ++read; const began = epoch;
    try {
      const received = await api.bridgeStatus();
      if (requested !== read || began !== epoch) return;
      bridge = received; unknown = false; checked = true;
      for (const grant of received.connections) seenConnections.add(grant.id);
      const nextConnections = JSON.stringify(received.connections);
      if (nextConnections !== connectionState) { connectionState = nextConnections; context.onAccessChanged(); }
    } catch {
      if (requested !== read || began !== epoch) return;
      unknown = true; checked = true;
    }
    render();
  }

  async function mutate(name: string, operation: () => Promise<BridgeStatus>, success: string, failure: string): Promise<void> {
    if (changing && (name !== 'stop' || changing === 'stop')) return;
    const began = ++epoch; read++; changing = name;
    if (name === 'start') bridge = { state: 'starting', permissions: [], pendingApprovals: [], connections: [] };
    message(''); render();
    try {
      const received = await operation();
      if (began !== epoch) return;
      bridge = received; unknown = false; changing = null;
      for (const grant of received.connections) seenConnections.add(grant.id);
      const succeeded = received.state !== 'error' && (name !== 'start' || received.state === 'ready')
        && (name !== 'stop' || received.state === 'off');
      message(succeeded ? success : received.message ?? failure, !succeeded); render(); context.onAccessChanged();
    } catch {
      if (began !== epoch) return;
      changing = null; unknown = true;
      message(failure, true); render();
      await refresh();
    }
  }

  function drawPending(): void {
    const pending = !unknown && bridge?.state === 'ready' && changing !== 'stop' ? bridge.pendingApprovals : [];
    const signature = JSON.stringify([pending, bridge?.expiresInDays, changing, unknown]);
    if (signature === pendingSignature) return;
    pendingSignature = signature;
    const list = element('bridge-approvals'); list.replaceChildren();
    element('bridge-approvals-section').hidden = pending.length === 0;
    for (const [id, code] of acknowledged) {
      if (!pending.some(value => value.id === id && value.verificationCode === code)) acknowledged.delete(id);
    }
    for (const request of pending) {
      const card = document.createElement('article'); card.className = 'bridge-approval'; card.dataset.approvalId = request.id;
      const heading = document.createElement('h4'); heading.textContent = request.clientName;
      const origin = document.createElement('p'); origin.className = 'connection-meta';
      origin.textContent = `App-supplied name · Returns to ${request.redirectOrigin}`;
      const permissions = document.createElement('p'); permissions.className = 'connection-permissions'; permissions.textContent = scopes(request.permissions);
      const duration = document.createElement('p'); duration.className = 'connection-info';
      duration.textContent = bridge?.expiresInDays ? `Maximum access: ${bridge.expiresInDays} days. Stopping Interego or web access ends it sooner.`
        : 'Stopping Interego or web access ends this connection.';
      const codeLabel = document.createElement('p'); codeLabel.className = 'connection-info'; codeLabel.textContent = 'Compare this code with the authorization page you just opened:';
      const code = document.createElement('strong'); code.className = 'bridge-code'; code.textContent = request.verificationCode;
      const expires = document.createElement('p'); expires.className = 'connection-meta'; expires.textContent = `Request expires ${date(request.expiresAt)}.`;
      const label = document.createElement('label'); label.className = 'scope-choice';
      const match = document.createElement('input'); match.type = 'checkbox'; match.checked = acknowledged.get(request.id) === request.verificationCode;
      match.setAttribute('aria-label', `The code matches for ${request.clientName}`); match.disabled = changing !== null;
      const explanation = document.createElement('span'); explanation.textContent = 'I started this request, and the code matches my browser.';
      label.append(match, explanation);
      const actions = document.createElement('div'); actions.className = 'connection-actions';
      const deny = document.createElement('button'); deny.type = 'button'; deny.className = 'secondary'; deny.textContent = 'Deny';
      deny.setAttribute('aria-label', `Deny ${request.clientName}`); deny.disabled = changing !== null;
      const approve = document.createElement('button'); approve.type = 'button'; approve.className = 'primary'; approve.textContent = 'Allow this connection';
      approve.setAttribute('aria-label', `Allow ${request.clientName}`); approve.disabled = changing !== null || !match.checked;
      match.addEventListener('change', () => {
        if (match.checked) acknowledged.set(request.id, request.verificationCode); else acknowledged.delete(request.id);
        approve.disabled = !live() || !match.checked;
      });
      const current = (): BridgePendingApproval | undefined => live() ? bridge?.pendingApprovals.find(value => value.id === request.id && value.verificationCode === request.verificationCode) : undefined;
      approve.addEventListener('click', () => {
        if (!current() || acknowledged.get(request.id) !== request.verificationCode) return;
        void mutate('approve', () => api.approveBridge(request.id), 'Connection allowed. Finish in your browser, then try the assistant.', 'Approval could not be confirmed. Check the request again before retrying.');
      });
      deny.addEventListener('click', () => {
        if (!current()) return;
        void mutate('deny', () => api.denyBridge(request.id), 'Request denied. That request cannot connect.', 'The denial could not be confirmed. Check web access or stop it to block connections.');
      });
      actions.append(deny, approve);
      card.append(heading, origin, permissions, duration, codeLabel, code, expires, label, actions); list.append(card);
    }
  }

  function drawConnections(): void {
    const grants = !unknown ? bridge?.connections ?? [] : [];
    const signature = JSON.stringify([grants, changing, unknown]);
    if (signature === connectionsSignature) return;
    connectionsSignature = signature;
    const list = element('bridge-connections'); list.replaceChildren();
    element('bridge-connections-section').hidden = grants.length === 0;
    for (const grant of grants) {
      const row = document.createElement('article'); row.className = 'bridge-grant'; row.dataset.bridgeConnectionId = grant.id;
      const name = document.createElement('h4'); name.textContent = grant.name;
      const detail = document.createElement('p'); detail.className = 'connection-meta';
      const active = grant.state === 'waiting' || grant.state === 'active';
      const labels = { waiting: 'Waiting for first use', active: 'Access allowed', revoked: 'Disconnected', expired: 'Expired', 'pod-changed': 'Different space' };
      detail.textContent = `${labels[grant.state]} · ${scopes(grant.permissions)} · Expires ${date(grant.expiresAt)}`;
      row.append(name, detail);
      if (active) {
        const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'danger'; revoke.textContent = 'Disconnect';
        revoke.setAttribute('aria-label', `Disconnect web connection ${grant.name}`); revoke.disabled = changing !== null;
        revoke.addEventListener('click', () => {
          if (!live()) return;
          void mutate('revoke', async () => { await api.revokeConnection(grant.id); return api.bridgeStatus(); }, 'This web connection is disconnected.', 'The disconnection could not be confirmed. Refresh web access or stop it to block all web connections.');
        });
        row.append(revoke);
      }
      list.append(row);
    }
  }

  function render(): void {
    const starting = changing === 'start' || bridge?.state === 'starting';
    const stopping = changing === 'stop';
    const active = starting || bridge?.state === 'ready';
    const title = stopping ? 'Stopping web access…' : !checked ? 'Checking web access…' : unknown ? 'Web access could not be checked'
      : starting ? 'Preparing temporary web access…' : bridge?.state === 'ready' ? 'Temporary web access is on'
        : bridge?.state === 'error' ? 'Web access needs another try' : 'Web access is off';
    element('bridge-status-label').textContent = title;
    element('bridge-status-label').classList.toggle('inactive', !live());
    element('bridge-status-detail').textContent = stopping ? 'Blocking requests and closing the temporary connection.'
      : !checked ? 'Reading the current connection status.'
      : unknown ? 'Refresh to check. Use Stop web access if you want to block all web connections.'
        : starting ? 'This can take a little while. Your local notes remain available; you can close this setup and come back.'
          : bridge?.state === 'ready' ? 'Only connections you approve can use their granted tools. Keep Interego and this computer on.'
            : bridge?.state === 'error' ? bridge.message ?? 'Your local notes are still available. Retry to create a new temporary URL.'
              : 'Web assistants cannot reach your local notes through this bridge. Local app connections are managed separately.';
    button('start-bridge').hidden = active;
    button('start-bridge').disabled = !mayStart();
    button('start-bridge').textContent = bridge?.state === 'error' ? 'Try web setup again' : 'Connect a web assistant';
    button('bridge-setup-details').hidden = !active;
    const stoppable = active || unknown || bridge?.state === 'error' || changing !== null;
    for (const id of ['stop-bridge', 'stop-bridge-setup', 'bridge-alert-stop']) {
      button(id).hidden = !stoppable; button(id).disabled = stopping;
      button(id).textContent = stopping ? 'Stopping…' : 'Stop web access';
    }
    const permissions = (input('bridge-read').checked ? 1 : 0) + (input('bridge-create').checked ? 1 : 0);
    button('confirm-bridge-start').disabled = !mayStart() || !permissions || !input('bridge-consent').checked;
    button('confirm-bridge-start').textContent = starting ? 'Preparing…' : 'Turn on temporary web access';
    for (const id of ['bridge-client', 'bridge-expiry']) element<HTMLSelectElement>(id).disabled = active || changing !== null;
    for (const id of ['bridge-name', 'bridge-read', 'bridge-create', 'bridge-consent']) input(id).disabled = active || changing !== null;
    element('bridge-scope-help').textContent = input('bridge-read').checked
      ? 'The assistant may read all current and future notes, and send what it reads to its AI provider.'
      : input('bridge-create').checked ? 'The assistant may save new notes. It cannot read your existing notes.' : 'Choose at least one permission.';
    element('bridge-form').hidden = active || stopping;
    element('bridge-setup').hidden = !active && !stopping;
    element('bridge-setup-progress').hidden = !starting;
    element('bridge-setup-ready').hidden = !live();
    element('bridge-setup-status').textContent = title;
    element('bridge-url').textContent = live() ? bridge?.url ?? '' : '';
    button('copy-bridge-url').disabled = !live() || !bridge?.url;
    button('open-bridge-client').disabled = !live();
    button('open-bridge-client').textContent = bridge?.client === 'other-web' ? 'Open MCP documentation ↗' : `Open ${CLIENTS[bridge?.client ?? 'chatgpt-web']} setup ↗`;
    const client = bridge?.client ?? 'chatgpt-web';
    element('bridge-client-instructions').textContent = client === 'chatgpt-web'
      ? 'In ChatGPT Plugins, choose +, then Add custom MCP server. Paste this URL, choose OAuth and dynamic client registration if asked, then create and install the plugin. Choose Connect or Authenticate to open authorization.'
      : client === 'grok-bot'
        ? 'In Grok Bot, ask to add an MCP server using this URL, then open its authorization card. You can also use New Connector → Custom in Grok connectors. Complete OAuth in your browser.'
        : 'Add a remote MCP server in your assistant, paste this URL and choose OAuth. Use dynamic client registration if asked, then open authorization.';
    element('bridge-setup-permissions').textContent = bridge?.permissions.length ? `${scopes(bridge.permissions)}${bridge.expiresInDays ? ` · Up to ${bridge.expiresInDays} days, ending sooner when Interego or web access stops.` : ''}` : '';
    const pending = !unknown && bridge?.state === 'ready' && changing !== 'stop' ? bridge.pendingApprovals.length : 0;
    const alert = element('bridge-alert');
    alert.hidden = !checked || (!active && !unknown && bridge?.state !== 'error');
    element('bridge-alert-title').textContent = pending ? `${pending === 1 ? 'A web app is' : `${pending} web apps are`} asking to connect` : title;
    element('bridge-alert-description').textContent = pending ? 'Allow only a request you started. Compare its code with your browser before approving.'
      : unknown ? 'Connection status is unknown. Refresh or stop web access to check.' : 'Your pod stays on this computer. Federation is off.';
    button('bridge-review').textContent = pending ? 'Review request' : 'View web access';
    button('bridge-setup-review').hidden = !pending;
    element('bridge-availability').textContent = context.pod()?.restorePending ? 'Finish restoring your local space before creating web access.'
      : !context.pod()?.running ? 'Start your local space to set up a web connection.' : 'Optional. Starts only when you choose it, and turns off when Interego closes.';
    drawPending(); drawConnections();
  }

  function begin(): void {
    if (!mayStart()) return;
    form.reset(); previousClient = 'chatgpt-web'; input('bridge-name').value = 'ChatGPT web'; message(''); render();
    context.openDialog(dialog); element('bridge-client').focus();
  }
  const stop = () => { void mutate('stop', () => api.stopBridge(), 'Web access is off. Bridge connections must be set up again to reconnect.', 'Stopping could not be confirmed. Try Stop web access again.'); };
  button('start-bridge').addEventListener('click', begin);
  button('bridge-setup-details').addEventListener('click', () => { context.openDialog(dialog); button('close-bridge').focus(); });
  for (const id of ['stop-bridge', 'stop-bridge-setup', 'bridge-alert-stop']) button(id).addEventListener('click', stop);
  for (const id of ['bridge-review', 'bridge-setup-review']) button(id).addEventListener('click', review);
  for (const id of ['refresh-bridge', 'bridge-dialog-refresh']) button(id).addEventListener('click', () => { void refresh(); });
  for (const id of ['close-bridge', 'cancel-bridge']) button(id).addEventListener('click', () => context.closeDialog(dialog));
  dialog.addEventListener('cancel', event => { event.preventDefault(); context.closeDialog(dialog); });
  element<HTMLSelectElement>('bridge-client').addEventListener('change', () => {
    const next = element<HTMLSelectElement>('bridge-client').value as BridgeClient;
    if (!(next in CLIENTS)) return;
    if (!input('bridge-name').value || input('bridge-name').value === CLIENTS[previousClient]) input('bridge-name').value = CLIENTS[next];
    previousClient = next;
  });
  for (const id of ['bridge-read', 'bridge-create', 'bridge-consent']) input(id).addEventListener('change', render);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!mayStart()) return;
    const client = element<HTMLSelectElement>('bridge-client').value as BridgeClient;
    const name = input('bridge-name').value.trim();
    const days = Number(element<HTMLSelectElement>('bridge-expiry').value);
    const permissions: AgentPermission[] = [];
    if (input('bridge-read').checked) permissions.push('notes:read');
    if (input('bridge-create').checked) permissions.push('notes:create');
    if (!(client in CLIENTS) || !name || name.length > 80 || ![7, 30, 90].includes(days) || !permissions.length || !input('bridge-consent').checked) {
      message('Choose an app, a name and permissions, then confirm temporary web access.', true); return;
    }
    void mutate('start', () => api.startBridge({ client, name, permissions, expiresInDays: days as 7 | 30 | 90 }),
      'Your temporary URL is ready. Add it in your assistant, then approve the matching request in Interego.', 'Web access could not start. Your choices are still here. Refresh and try again.');
  });
  for (const [id, operation, success, failure] of [
    ['copy-bridge-url', () => api.copyBridgeUrl(), 'URL copied. Paste it into your assistant’s remote MCP setup.', 'The URL could not be copied. Please try again.'],
    ['open-bridge-client', () => api.openBridgeClient(bridge?.client ?? 'chatgpt-web'), 'Setup opened in your browser.', 'The setup page could not be opened. You can open your assistant’s app settings yourself.'],
  ] as const) button(id).addEventListener('click', () => {
    if (!live()) return;
    const began = epoch;
    void operation().then(() => { if (began === epoch) message(success); }, () => { if (began === epoch) message(failure, true); });
  });
  render();
  return { refresh, updateAvailability: render, isWebConnection: id => seenConnections.has(id), openSetup: () => {
    context.showConnections();
    if (bridge?.state === 'ready' || bridge?.state === 'starting') { context.openDialog(dialog); button('close-bridge').focus(); }
  } };
}
