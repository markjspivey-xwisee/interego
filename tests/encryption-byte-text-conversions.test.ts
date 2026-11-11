/**
 * The envelope cipher converts between text, bytes and base64 on every seal
 * and open. Those conversions were moved off tweetnacl-util's per-byte path
 * (which Node takes because it has a global `atob`). The contract is that
 * nothing observable changed: the same ciphertext opens to the same text, and
 * what was refused is still refused.
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';
import {
  createEncryptedEnvelope, decryptContent, deriveEncryptionKeyPair, encryptContent, generateContentKey, openEncryptedEnvelope,
} from '@interego/core';

const texts = [
  '', 'plain ascii', 'ünïcödé — ☃ 日本語', '﻿leading byte order mark', 'nul\u0000inside', 'astral 😀 𝒳 \u{10FFFF}',
  '￿￾ noncharacters', 'x'.repeat(200_000), JSON.stringify({ nodes: Array.from({ length: 500 }, (_, i) => 'urn:node:' + i + ':é') }),
];

describe('envelope byte/text conversions', () => {
  it.each(texts.map((text, index) => [index, text] as const))('seals text %i to what tweetnacl-util opens, and opens what it seals', (_index, text) => {
    const key = generateContentKey();
    const sealed = encryptContent(text, key);
    const opened = nacl.secretbox.open(util.decodeBase64(sealed.ciphertext), util.decodeBase64(sealed.nonce), util.decodeBase64(key.key));
    expect(opened).not.toBeNull();
    expect(util.encodeUTF8(opened!)).toBe(text);
    expect(Buffer.from(opened!).equals(Buffer.from(text, 'utf8'))).toBe(true);

    const nonce = nacl.randomBytes(24);
    const reference = { ciphertext: util.encodeBase64(nacl.secretbox(util.decodeUTF8(text), nonce, util.decodeBase64(key.key))),
      nonce: util.encodeBase64(nonce), algorithm: 'XSalsa20-Poly1305' as const, encryptedAt: new Date().toISOString() };
    expect(decryptContent(reference, key)).toBe(text);
    expect(decryptContent(sealed, key)).toBe(text);
  });

  it('round-trips random bytes through base64 exactly as tweetnacl-util encodes them', () => {
    for (const length of [0, 1, 2, 3, 31, 32, 33, 4096, 70_001]) {
      const bytes = Uint8Array.from(randomBytes(length));
      // Latin-1 text carries arbitrary bytes through the UTF-8 leg as well.
      const text = Buffer.from(bytes).toString('latin1'), key = generateContentKey();
      const sealed = encryptContent(text, key);
      expect(sealed.ciphertext).toBe(util.encodeBase64(util.decodeBase64(sealed.ciphertext)));
      expect(decryptContent(sealed, key)).toBe(text);
    }
  });

  it('still refuses text that has no UTF-8 form instead of replacing it', () => {
    const key = generateContentKey();
    for (const text of ['lone high \uD83D', '\uDE00 lone low', 'mid\uD800dle']) {
      expect(() => util.decodeUTF8(text)).toThrow(URIError);
      expect(() => encryptContent(text, key)).toThrow(URIError);
    }
  });

  it('still refuses plaintext bytes that are not UTF-8, with the same error', () => {
    const key = generateContentKey();
    for (const bytes of [[0xff], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xe2, 0x82], [0xf4, 0x90, 0x80, 0x80]]) {
      const nonce = nacl.randomBytes(24);
      const sealed = { ciphertext: util.encodeBase64(nacl.secretbox(Uint8Array.from(bytes), nonce, util.decodeBase64(key.key))),
        nonce: util.encodeBase64(nonce), algorithm: 'XSalsa20-Poly1305' as const, encryptedAt: new Date().toISOString() };
      expect(() => util.encodeUTF8(Uint8Array.from(bytes))).toThrow(URIError);
      expect(() => decryptContent(sealed, key)).toThrow(URIError);
    }
  });

  it('still refuses base64 that tweetnacl-util refuses', () => {
    const key = generateContentKey(), sealed = encryptContent('text', key);
    for (const ciphertext of ['abc', 'ab=c', 'a===', 'ab$=', sealed.ciphertext + '\n', ' ' + sealed.ciphertext, sealed.ciphertext.replace(/.$/, '-'), 'ab==cd==']) {
      expect(() => util.decodeBase64(ciphertext)).toThrow(TypeError);
      expect(() => decryptContent({ ...sealed, ciphertext }, key)).toThrow(TypeError);
    }
    expect(decryptContent({ ...sealed, ciphertext: '' }, key)).toBeNull();
  });

  it('opens a whole envelope of a large payload for each recipient', () => {
    const sender = deriveEncryptionKeyPair('1'.repeat(64)), reader = deriveEncryptionKeyPair('2'.repeat(64));
    const text = '{"é":"' + '日本語😀'.repeat(20_000) + '"}';
    const envelope = createEncryptedEnvelope(text, [sender.publicKey, reader.publicKey], sender);
    expect(openEncryptedEnvelope(envelope, reader)).toBe(text);
    expect(openEncryptedEnvelope(envelope, sender)).toBe(text);
  });
});
