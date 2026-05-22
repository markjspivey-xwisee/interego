/**
 * Foxxi content channels — rendering generated content for the channels
 * a text artifact actually travels through.
 *
 * The cmi5 / SCORM package path (content-package.ts) delivers a course
 * onto an LMS. But generated content is text, and most performance
 * support and micro-instruction does not belong in an LMS at all — it
 * belongs in the flow of work: a chat message, an email, an SMS, or a
 * document.
 *
 * A channel does not fix the *form* of the text. The same content unit
 * can travel as plain text, markdown, static HTML hypertext, or a
 * self-contained interactive hypermedia artifact — whatever the
 * situation calls for. `content-forms.ts` renders the form; this module
 * picks the form that fits the channel (its ceiling, the content kind,
 * the audience) and applies the channel's envelope (an SMS length
 * bound, an email subject line). A caller may also name a form.
 *
 * Every channel delivery is still instrumentable: content-delivery.ts
 * emits an xAPI statement for each delivery, and — for the document
 * channel — content-transport.ts publishes it to the pod.
 *
 * Layer: L3 vertical. Pure rendering; no L1/L2/L3 ontology change.
 */

import { renderInForm, chooseForm, type ContentForm } from './content-forms.js';

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
  /** The text form the body was rendered in. */
  form: ContentForm;
  /** IANA media type of the body. */
  mediaType: string;
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

/** Options for rendering a unit to a channel. */
export interface RenderForChannelOptions {
  /** Force a text form (otherwise the form is chosen for the situation). */
  form?: ContentForm;
  /** The audience — an agent gets structured markdown, not hypermedia. */
  audience?: 'human' | 'agent';
}

const SMS_LIMIT = 320; // two concatenated SMS segments — a practical bound

const FORM_NOTE: Record<ContentForm, string> = {
  plain: 'plain text — no formatting; fits length-bounded channels.',
  markdown: 'markdown — portable structured text; renders in chat, docs, wikis.',
  html: 'static HTML hypertext — a styled page with working links.',
  interactive: 'an interactive HTML artifact — collapsible sections + an inline '
    + 'self-check for assessment items; self-contained, opens in any browser.',
};

/**
 * Render a content unit for a delivery channel. The form is chosen for
 * the situation — or taken from `opts.form` — and the channel's envelope
 * (SMS truncation, email subject) is applied.
 */
export function renderForChannel(
  unit: ContentUnit, channel: DeliveryChannel, opts: RenderForChannelOptions = {},
): ChannelRendering {
  // The SMS channel is a hard plain-text, length-bounded ceiling.
  const form: ContentForm = channel === 'sms'
    ? 'plain'
    : opts.form ?? chooseForm({ channel, kind: unit.kind, audience: opts.audience });
  const rendered = renderInForm(unit, form);

  let body = rendered.body;
  let truncated = false;
  if (channel === 'sms' && body.length > SMS_LIMIT) {
    const tail = unit.link ? ` ${unit.link}` : '';
    body = body.slice(0, SMS_LIMIT - tail.length - 1).trimEnd() + '…' + tail;
    truncated = true;
  }

  return {
    channel,
    form: rendered.form,
    mediaType: rendered.mediaType,
    ...(channel === 'email' ? { subject: unit.title } : {}),
    body,
    length: body.length,
    truncated,
    note: `${channel} channel · ${FORM_NOTE[rendered.form]}`
      + (truncated ? ' (truncated to fit; the link carries the full content)' : ''),
  };
}

/** Render the unit for every channel at once. */
export function renderAllChannels(unit: ContentUnit, opts: RenderForChannelOptions = {}): ChannelRendering[] {
  return DELIVERY_CHANNELS.map(c => renderForChannel(unit, c, opts));
}
