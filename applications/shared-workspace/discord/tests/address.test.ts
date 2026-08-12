/**
 * WHEN DOES TYPED PROSE BECOME AN ADDRESSED REQUEST?
 *
 * ★ EVERY CASE HERE IS ABOUT THE DIRECTION OF A MISTAKE. Addressing writes a permanent triple into
 * a signed record saying who a request is FOR. Reading an address out of a sentence that merely
 * mentions somebody would put a request in the record that its author never made — so the whole
 * file is biased towards NOT finding one, and the cases below are mostly the ways prose can look
 * like an address.
 *
 * The mirror risk is real too and is why the positive cases exist: a form so narrow that nobody
 * can hit it sends people back to the slash command, which is what this was added to avoid.
 */
import { describe, expect, it } from 'vitest';
import { addressedText, NAME_MAX } from '../src/address.js';

describe('addressedText — the narrow form that counts as naming somebody', () => {
  it.each([
    ['a comma', 'Claude Desktop, what do you think?', 'Claude Desktop', 'what do you think?'],
    ['a colon', 'Claude Desktop: summarise the thread', 'Claude Desktop', 'summarise the thread'],
    ['a leading @, which people type from habit', '@Claude Desktop, go', 'Claude Desktop', 'go'],
    ['one capitalised word', 'Scribe: do the thing', 'Scribe', 'do the thing'],
    ['leading whitespace', '   Claude Desktop, hello', 'Claude Desktop', 'hello'],
  ])('reads %s', (_what, text, spec, rest) => {
    expect(addressedText(text)).toEqual({ spec, rest });
  });

  // ★ THE REFUSALS. Each is a real sentence somebody types in a channel every day.
  it.each([
    ['no separator at all', 'what do you think Claude Desktop'],
    ['a lowercase discourse marker', 'anyway, we should re-tile'],
    ['another one', 'so: I looked at the quote'],
    ['a name mentioned mid-sentence', 'I asked Claude Desktop yesterday, and it said no'],
    ['a name with nothing after it', 'Claude Desktop,'],
    ['an empty opening', ', hello'],
    ['a whole sentence before the comma', 'when I looked at the roof this morning it was clear, so we should wait'],
  ])('refuses %s', (_what, text) => {
    expect(addressedText(text).spec).toBeNull();
  });

  it('★ never edits what was said — `rest` is for emptiness, the record keeps the whole line', () => {
    // The entry written is the FULL text. A record holding only "do X" when the person typed
    // "Claude Desktop, do X" would be this bot editing somebody's words on their own pod.
    const out = addressedText('Claude Desktop, do X');
    expect(out.rest).toBe('do X');
    expect(out.spec).toBe('Claude Desktop');
  });

  it('bounds the NAME rather than the message, so a long line with a comma is not an address', () => {
    const long = 'A'.repeat(NAME_MAX + 5) + ', and then some';
    expect(addressedText(long).spec).toBeNull();
    // …while a message that is long AFTER a short name still addresses fine.
    const short = 'Scribe: ' + 'x'.repeat(4000);
    expect(addressedText(short).spec).toBe('Scribe');
  });

  it('★ decides nothing about whether that agent exists', () => {
    // Whether anybody answers to the name is `resolveTarget`'s question, asked against the pods
    // that own the answer. This only reports what was typed — a matcher here would be a second
    // matcher, and two matchers disagree the day somebody fixes one.
    expect(addressedText('Nobody At All, hello').spec).toBe('Nobody At All');
  });
});
