/**
 * Foxxi content channels — rendering generated content for the channels
 * a text artifact actually travels through.
 *
 * The cmi5 / SCORM package path (content-package.ts) delivers a course
 * onto an LMS. But generated content is text, and most performance
 * support and micro-instruction does not belong in an LMS at all — it
 * belongs in the flow of work: a chat message, an email, an SMS, or a
 * document. This module renders a unit of content for each channel.
 *
 * Every channel delivery is still instrumentable: content-delivery.ts
 * emits an xAPI statement for each delivery, so a job aid sent to a chat
 * channel is logged in the LRS exactly as a launched lesson would be.
 *
 * Layer: L3 vertical. Pure rendering; no L1/L2/L3 ontology change.
 */

export type DeliveryChannel = 'document' | 'email' | 'chat' | 'sms';

export const DELIVERY_CHANNELS: readonly DeliveryChannel[] = ['document', 'email', 'chat', 'sms'];

/** A unit of content to render — a lesson, a job aid, an outline. */
export interface ContentUnit {
  title: string;
  kind: 'lesson' | 'job-aid' | 'course-outline' | 'assessment' | 'reference';
  competency?: string;
  /** The text blocks — each optionally labelled (e.g. a fragment modality). */
  blocks: Array<{ label?: string; text: string }>;
  /** An optional link to the full / runnable version. */
  link?: string;
}

export interface ChannelRendering {
  channel: DeliveryChannel;
  /** Email only — the subject line. */
  subject?: string;
  /** The channel-formatted body text. */
  body: string;
  /** Body length in characters — surfaced because SMS is length-bounded. */
  length: number;
  /** Whether the body was truncated to fit the channel. */
  truncated: boolean;
  note: string;
}

const SMS_LIMIT = 320; // two concatenated SMS segments — a practical bound

/** Render a content unit for a delivery channel. */
export function renderForChannel(unit: ContentUnit, channel: DeliveryChannel): ChannelRendering {
  switch (channel) {
    case 'document': return renderDocument(unit);
    case 'email': return renderEmail(unit);
    case 'chat': return renderChat(unit);
    case 'sms': return renderSms(unit);
  }
}

/** Render the unit for every channel at once. */
export function renderAllChannels(unit: ContentUnit): ChannelRendering[] {
  return DELIVERY_CHANNELS.map(c => renderForChannel(unit, c));
}

function renderDocument(u: ContentUnit): ChannelRendering {
  const lines: string[] = [`# ${u.title}`, ''];
  if (u.competency) lines.push(`*Competency: ${u.competency}*`, '');
  for (const b of u.blocks) {
    if (b.label) lines.push(`## ${b.label}`, '');
    lines.push(b.text, '');
  }
  if (u.link) lines.push(`---`, `Full version: ${u.link}`);
  const body = lines.join('\n').trim() + '\n';
  return { channel: 'document', body, length: body.length, truncated: false,
    note: 'Markdown document — exportable to a doc, a wiki page, or a knowledge base.' };
}

function renderEmail(u: ContentUnit): ChannelRendering {
  const lines: string[] = [
    `Here is the ${u.kind.replace('-', ' ')} you need${u.competency ? ` for "${u.competency}"` : ''}:`,
    '',
  ];
  for (const b of u.blocks) {
    if (b.label) lines.push(`${b.label}:`);
    lines.push(b.text, '');
  }
  if (u.link) lines.push(`Open the full version: ${u.link}`, '');
  lines.push('— Foxxi');
  const body = lines.join('\n');
  return { channel: 'email', subject: u.title, body, length: body.length, truncated: false,
    note: 'Plain-text email — a subject line plus the body; send via any mail transport.' };
}

function renderChat(u: ContentUnit): ChannelRendering {
  const lines: string[] = [`*${u.title}*`];
  if (u.competency) lines.push(`_${u.competency}_`);
  lines.push('');
  for (const b of u.blocks) {
    lines.push(b.label ? `• *${b.label}* — ${b.text}` : `• ${b.text}`);
  }
  if (u.link) lines.push('', `→ ${u.link}`);
  const body = lines.join('\n');
  return { channel: 'chat', body, length: body.length, truncated: false,
    note: 'A chat message (lightweight markdown) — post to a Slack / Teams / chat channel.' };
}

function renderSms(u: ContentUnit): ChannelRendering {
  const first = u.blocks[0]?.text ?? '';
  let body = `${u.title}: ${first}`;
  const tail = u.link ? ` ${u.link}` : '';
  let truncated = false;
  if (body.length + tail.length > SMS_LIMIT) {
    body = body.slice(0, SMS_LIMIT - tail.length - 1).trimEnd() + '…';
    truncated = true;
  }
  body += tail;
  return { channel: 'sms', body, length: body.length, truncated,
    note: truncated
      ? 'An SMS — truncated to fit; the link carries the full content.'
      : 'An SMS — short enough to send as one or two segments.' };
}
