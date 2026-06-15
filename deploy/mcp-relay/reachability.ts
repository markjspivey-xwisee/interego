/**
 * @module reachability
 * @description One logical "reach this agent" API over heterogeneous
 *              transports. An agent has a single identity (DID/WebID) and
 *              N declared reachability channels; `fanOut` routes one
 *              message to every channel via its adapter.
 *
 * Native channels (always available, in-substrate):
 *   - ldn          → the agent's Linked Data Notifications inbox (relay-mediated)
 *   - activitypub  → the agent's ActivityPub inbox (same destination)
 *
 * Bridge channels (adapters; live only when their credentials/targets
 * are present — otherwise reported as `not configured`, never faked):
 *   - discord   → a Discord webhook URL (the channel value IS the webhook; no secret needed)
 *   - telegram  → Telegram Bot API (needs TELEGRAM_BOT_TOKEN; value = chat_id)
 *   - email     → SendGrid API (needs SENDGRID_API_KEY; value = address)
 *   - sms       → Twilio Messages (needs TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER; value = E.164)
 *   - voice     → Twilio Calls + TwiML <Say> (same Twilio creds; value = E.164)
 *
 * This mirrors how Interego abstracts multiple standards elsewhere
 * (Foxxi-as-LRS/LMS over xAPI/SCORM/LTI): the substrate is the
 * abstraction; transports are adapters behind it.
 */

export interface Channel { type: string; value: string; }

export interface DeliveryResult {
  type: string;
  ok: boolean;
  /** 'delivered' | 'skipped' | 'error' */
  status: 'delivered' | 'skipped' | 'error';
  detail?: string;
}

export interface ReachMessage {
  summary: string;
  content?: string;
  about?: string;
  from: string;
}

/** Closures the fan-out needs from the relay (keeps this module pure of relay internals). */
export interface FanoutDeps {
  /** Relay-mediated LDN delivery; returns the notification URL or null. */
  deliverLdn: () => Promise<string | null>;
}

function shortText(m: ReachMessage): string {
  const parts = [m.summary];
  if (m.content) parts.push(m.content);
  if (m.about) parts.push(`(${m.about})`);
  return parts.join('\n');
}

// ── Bridge adapters ─────────────────────────────────────────

async function sendDiscord(ch: Channel, m: ReachMessage): Promise<DeliveryResult> {
  // The channel value is a Discord webhook URL — no relay-side secret needed.
  if (!/^https:\/\/(.+\.)?discord(app)?\.com\/api\/webhooks\//.test(ch.value)) {
    return { type: 'discord', ok: false, status: 'skipped', detail: 'channel value is not a Discord webhook URL' };
  }
  try {
    const r = await fetch(ch.value, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: shortText(m).slice(0, 1900) }),
    });
    return r.ok || r.status === 204
      ? { type: 'discord', ok: true, status: 'delivered' }
      : { type: 'discord', ok: false, status: 'error', detail: `HTTP ${r.status}` };
  } catch (e) { return { type: 'discord', ok: false, status: 'error', detail: (e as Error).message }; }
}

async function sendTelegram(ch: Channel, m: ReachMessage): Promise<DeliveryResult> {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  if (!token) return { type: 'telegram', ok: false, status: 'skipped', detail: 'not configured (set TELEGRAM_BOT_TOKEN)' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ch.value, text: shortText(m).slice(0, 4000) }),
    });
    return r.ok
      ? { type: 'telegram', ok: true, status: 'delivered' }
      : { type: 'telegram', ok: false, status: 'error', detail: `HTTP ${r.status}` };
  } catch (e) { return { type: 'telegram', ok: false, status: 'error', detail: (e as Error).message }; }
}

async function sendEmail(ch: Channel, m: ReachMessage): Promise<DeliveryResult> {
  const key = process.env['SENDGRID_API_KEY'];
  const from = process.env['REACH_EMAIL_FROM'];
  if (!key || !from) return { type: 'email', ok: false, status: 'skipped', detail: 'not configured (set SENDGRID_API_KEY + REACH_EMAIL_FROM)' };
  try {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: ch.value }] }],
        from: { email: from },
        subject: m.summary.slice(0, 120),
        content: [{ type: 'text/plain', value: shortText(m) }],
      }),
    });
    return r.ok || r.status === 202
      ? { type: 'email', ok: true, status: 'delivered' }
      : { type: 'email', ok: false, status: 'error', detail: `HTTP ${r.status}` };
  } catch (e) { return { type: 'email', ok: false, status: 'error', detail: (e as Error).message }; }
}

function twilioCreds(): { sid: string; token: string; from: string } | null {
  const sid = process.env['TWILIO_ACCOUNT_SID'];
  const token = process.env['TWILIO_AUTH_TOKEN'];
  const from = process.env['TWILIO_FROM_NUMBER'];
  return sid && token && from ? { sid, token, from } : null;
}

async function sendSms(ch: Channel, m: ReachMessage): Promise<DeliveryResult> {
  const c = twilioCreds();
  if (!c) return { type: 'sms', ok: false, status: 'skipped', detail: 'not configured (set TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER)' };
  try {
    const body = new URLSearchParams({ To: ch.value, From: c.from, Body: shortText(m).slice(0, 1500) });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Messages.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${c.sid}:${c.token}`).toString('base64')}` },
      body: body.toString(),
    });
    return r.ok || r.status === 201
      ? { type: 'sms', ok: true, status: 'delivered' }
      : { type: 'sms', ok: false, status: 'error', detail: `HTTP ${r.status}` };
  } catch (e) { return { type: 'sms', ok: false, status: 'error', detail: (e as Error).message }; }
}

async function sendVoice(ch: Channel, m: ReachMessage): Promise<DeliveryResult> {
  const c = twilioCreds();
  if (!c) return { type: 'voice', ok: false, status: 'skipped', detail: 'not configured (set TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER)' };
  try {
    const twiml = `<Response><Say>${escapeXml(m.summary).slice(0, 600)}</Say></Response>`;
    const body = new URLSearchParams({ To: ch.value, From: c.from, Twiml: twiml });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Calls.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${c.sid}:${c.token}`).toString('base64')}` },
      body: body.toString(),
    });
    return r.ok || r.status === 201
      ? { type: 'voice', ok: true, status: 'delivered' }
      : { type: 'voice', ok: false, status: 'error', detail: `HTTP ${r.status}` };
  } catch (e) { return { type: 'voice', ok: false, status: 'error', detail: (e as Error).message }; }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Deliver one message to every channel an agent declares. The native LDN
 * channel is always attempted (via the injected deliverLdn closure);
 * bridge channels run their adapter. Returns a per-channel result list —
 * partial success is normal (LDN delivered, SMS skipped-because-unconfigured).
 */
export async function fanOut(
  channels: ReadonlyArray<Channel>,
  message: ReachMessage,
  deps: FanoutDeps,
): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];

  // Native LDN is always attempted.
  const ldnUrl = await deps.deliverLdn();
  results.push(ldnUrl
    ? { type: 'ldn', ok: true, status: 'delivered', detail: ldnUrl }
    : { type: 'ldn', ok: false, status: 'error', detail: 'LDN delivery failed' });

  for (const ch of channels) {
    switch (ch.type) {
      case 'ldn': case 'activitypub': case 'acct':
        // 'ldn' already done above; 'activitypub'/'acct' resolve to the
        // same inbox, so don't double-deliver.
        break;
      case 'discord':  results.push(await sendDiscord(ch, message)); break;
      case 'telegram': results.push(await sendTelegram(ch, message)); break;
      case 'email':    results.push(await sendEmail(ch, message)); break;
      case 'sms':      results.push(await sendSms(ch, message)); break;
      case 'voice':    results.push(await sendVoice(ch, message)); break;
      default:         results.push({ type: ch.type, ok: false, status: 'skipped', detail: 'unknown channel type' });
    }
  }
  return results;
}

/** Channel types that carry no secret in their value and are safe to store/show. */
export const KNOWN_CHANNEL_TYPES = ['ldn', 'activitypub', 'acct', 'discord', 'telegram', 'email', 'sms', 'voice'];
