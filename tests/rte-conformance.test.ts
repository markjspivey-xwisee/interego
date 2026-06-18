/**
 * SCORM Run-Time Environment (RTE) conformance — the third SCORM book.
 *
 * The RTE is browser code: deploy/foxxi-scorm-player/site/scorm-rte.js installs
 * window.API_1484_11 (SCORM 2004 4th Ed / IEEE 1484.11.2) + window.API (SCORM 1.2).
 * It can't run in the bridge, so this exercises it headlessly in jsdom — loading
 * the EXACT player script and driving the real API surface, data model, error
 * codes, read-only enforcement, and suspend_data limits. (The microsite surfaces
 * this as an attested result; it is not a live per-click bridge battery.)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const RTE_SRC = readFileSync(resolve(here, '../deploy/foxxi-scorm-player/site/scorm-rte.js'), 'utf8');

function loadRte(): { api2004: any; api12: any } {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://player.example/' });
  const w = dom.window as any;
  w.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
  w.parent = w; // SCOs discover the API via window.parent
  w.eval(RTE_SRC);
  return { api2004: w.API_1484_11 ?? w.parent.API_1484_11, api12: w.API ?? w.parent.API };
}

describe('SCORM 2004 4th Ed RTE — IEEE 1484.11.2 (API_1484_11)', () => {
  let api: any;
  beforeEach(() => { api = loadRte().api2004; });

  it('installs API_1484_11 with all 8 functions', () => {
    expect(api).toBeTruthy();
    for (const f of ['Initialize', 'Terminate', 'GetValue', 'SetValue', 'Commit', 'GetLastError', 'GetErrorString', 'GetDiagnostic']) {
      expect(typeof api[f], f).toBe('function');
    }
  });

  it('Initialize() succeeds and clears the error code', () => {
    expect(api.Initialize('')).toBe('true');
    expect(api.GetLastError()).toBe('0');
  });

  it('core CMI data model round-trips (SetValue → GetValue)', () => {
    api.Initialize('');
    const pairs: Array<[string, string]> = [
      ['cmi.completion_status', 'completed'],
      ['cmi.success_status', 'passed'],
      ['cmi.score.scaled', '0.92'],
      ['cmi.score.raw', '92'],
      ['cmi.score.min', '0'],
      ['cmi.score.max', '100'],
      ['cmi.location', 'slide-7'],
      ['cmi.progress_measure', '0.75'],
      ['cmi.suspend_data', 'state=xyz'],
    ];
    for (const [k, v] of pairs) {
      expect(api.SetValue(k, v), `SetValue ${k}`).toBe('true');
      expect(api.GetValue(k), `GetValue ${k}`).toBe(v);
    }
    expect(api.GetLastError()).toBe('0');
  });

  it('enforces read-only elements (§4.2 → error 404)', () => {
    api.Initialize('');
    for (const ro of ['cmi._version', 'cmi.learner_id', 'cmi.learner_name', 'cmi.credit', 'cmi.entry', 'cmi.mode', 'cmi.total_time']) {
      const r = api.SetValue(ro, 'x');
      expect(r, `SetValue read-only ${ro} should fail`).toBe('false');
      expect(api.GetLastError(), `read-only ${ro} error code`).toBe('404');
    }
  });

  it('enforces the SCORM 2004 suspend_data 64KB limit (§4.2.27.2)', () => {
    api.Initialize('');
    const tooBig = 'x'.repeat(64 * 1024 + 1);
    const r = api.SetValue('cmi.suspend_data', tooBig);
    expect(r).toBe('false');
    expect(api.GetLastError()).not.toBe('0');
  });

  it('GetErrorString returns a message for a known error code', () => {
    api.Initialize('');
    api.SetValue('cmi._version', 'x'); // provoke 404
    expect(api.GetErrorString('404').length).toBeGreaterThan(0);
  });

  it('Commit() and Terminate() succeed', () => {
    api.Initialize('');
    api.SetValue('cmi.completion_status', 'completed');
    expect(api.Commit('')).toBe('true');
    expect(api.Terminate('')).toBe('true');
  });
});

describe('SCORM 1.2 RTE — ADL CMI001 (window.API, LMS*)', () => {
  let api: any;
  beforeEach(() => { api = loadRte().api12; });

  it('installs the SCORM 1.2 API with the 8 LMS* functions', () => {
    expect(api).toBeTruthy();
    for (const f of ['LMSInitialize', 'LMSFinish', 'LMSGetValue', 'LMSSetValue', 'LMSCommit', 'LMSGetLastError', 'LMSGetErrorString', 'LMSGetDiagnostic']) {
      expect(typeof api[f], f).toBe('function');
    }
  });

  it('LMSInitialize + cmi.core.lesson_status round-trip', () => {
    expect(api.LMSInitialize('')).toBe('true');
    expect(api.LMSSetValue('cmi.core.lesson_status', 'completed')).toBe('true');
    expect(api.LMSGetValue('cmi.core.lesson_status')).toBe('completed');
    expect(api.LMSCommit('')).toBe('true');
    expect(api.LMSFinish('')).toBe('true');
  });
});
