/** Browser-only inbox rendering. Server strings are text, never markup. */
export function dashboardInboxScript(): string {
  return String.raw`
  function renderDashboardInboxError(card, error) {
    const heading = document.createElement('h2'); heading.textContent = '📬 Inbox';
    const message = document.createElement('div'); message.className = 'err';
    message.textContent = 'Could not load inbox: ' + (error && typeof error.message === 'string' ? error.message : 'Try again later.');
    card.replaceChildren(heading, message);
  }
  async function renderDashboardInbox(card) {
    const heading = document.createElement('h2'); heading.textContent = '📬 Inbox'; card.replaceChildren(heading);
    try {
      const inbox = await api(RELAY_BASE, '/dashboard/inbox?limit=20');
      if (!Number.isSafeInteger(inbox.count) || !Number.isSafeInteger(inbox.totalOnPod) || inbox.count < 0 || inbox.totalOnPod < inbox.count
        || !Array.isArray(inbox.events) || inbox.events.length !== inbox.count || inbox.events.length > 50) throw new Error('The inbox service returned an unfamiliar response.');
      const label = document.createElement('span'); label.style.cssText = 'color:#888;font-weight:400;font-size:0.85rem';
      label.textContent = ' (' + inbox.count + ' / ' + inbox.totalOnPod + ' in last 7 days)'; heading.appendChild(label);
      if (inbox.count === 0) {
        const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = typeof inbox.hint === 'string' ? inbox.hint : 'Nothing in the last 7 days.'; card.appendChild(empty);
      } else for (const event of inbox.events) {
        if (!event || typeof event.descriptorUrl !== 'string') throw new Error('The inbox service returned an unfamiliar entry.');
        const item = document.createElement('div'); item.className = 'inbox-item'; const row = document.createElement('div');
        if (['Asserted', 'Hypothetical', 'Counterfactual'].includes(event.modalStatus)) {
          const pill = document.createElement('span'); pill.className = 'pill pill-' + event.modalStatus.toLowerCase(); pill.textContent = event.modalStatus; row.appendChild(pill);
        }
        const url = document.createElement('span'); url.className = 'url'; url.textContent = event.descriptorUrl; row.appendChild(url);
        const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = (typeof event.validFrom === 'string' ? event.validFrom : 'no validFrom')
          + (typeof event.trustLevel === 'string' && event.trustLevel ? ' · ' + event.trustLevel : '');
        item.append(row, meta); card.appendChild(item);
      }
    } catch (error) {
      renderDashboardInboxError(card, error);
    }
  }
`;
}
