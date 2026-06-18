/**
 * Authoring-tool fingerprint tests.
 *
 * Grounded in REAL signatures: the canonical Rustici "Golf Explained" SCORM 2004
 * manifest that ships in this repo (deploy/foxxi-scorm-player/site/course/
 * imsmanifest.xml) must resolve to hand-authored (NO tool guessed), and the
 * Storyline/Rise/Captivate file-tree signals match our in-repo Python parser's
 * detect_authoring_tool. The remaining tools are checked against their documented
 * public package signatures.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprintAuthoringTool, detectStandard } from '../src/scorm-fingerprint.js';

const GOLF_MANIFEST = readFileSync(
  join(__dirname, '../../../deploy/foxxi-scorm-player/site/course/imsmanifest.xml'),
  'utf8',
);

describe('detectStandard', () => {
  it('detects SCORM 2004 from the real golf manifest', () => {
    const s = detectStandard(GOLF_MANIFEST);
    expect(s.standardId).toBe('SCORM_2004');
    expect(s.standard).toMatch(/SCORM 2004/);
    expect(s.schema).toMatch(/ADL SCORM/);
  });
  it('detects SCORM 1.2 by namespace', () => {
    const x = `<manifest xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"><metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata></manifest>`;
    expect(detectStandard(x).standardId).toBe('SCORM_12');
  });
  it('detects cmi5 / xAPI from file list', () => {
    expect(detectStandard(undefined, ['cmi5.xml', 'au/index.html']).standardId).toBe('CMI5');
    expect(detectStandard(undefined, ['tincan.xml', 'index.html']).standardId).toBe('XAPI');
  });
});

describe('fingerprintAuthoringTool — honesty on the real golf sample', () => {
  it('does NOT invent a tool for the hand-authored Rustici golf sample', () => {
    const r = fingerprintAuthoringTool({ manifestXml: GOLF_MANIFEST });
    expect(r.toolId).toBe('hand-authored');
    expect(r.confidence).toBe(0);
    expect(r.standard.standardId).toBe('SCORM_2004');
    expect(r.summary).toMatch(/hand-authored|No specific authoring tool/i);
  });
  it('recognizes the golf sample as hand-authored when its file tree is supplied', () => {
    const fileList = [
      'shared/launchpage.html', 'shared/scormfunctions.js', 'shared/contentfunctions.js',
      'Etiquette/Course.html', 'Handicapping/Overview.html', 'Playing/RulesOfGolf.html',
    ];
    const r = fingerprintAuthoringTool({ manifestXml: GOLF_MANIFEST, fileList });
    expect(r.toolId).toBe('hand-authored');
  });
});

describe('fingerprintAuthoringTool — real per-tool file-tree signatures', () => {
  it('Articulate Storyline: story_content/ + html5/data/js/data.js', () => {
    const fileList = ['story.html', 'story_content/slides/slide1.js', 'html5/data/js/data.js', 'mobile/index.html'];
    const fileContents = { 'html5/data/js/data.js': 'window.globalProvideData("data", {"projectId":"abc","courseId":"xyz","version":"3.95.30150.0"})' };
    const r = fingerprintAuthoringTool({ fileList, fileContents });
    expect(r.toolId).toBe('articulate-storyline');
    expect(r.tool).toBe('Articulate Storyline');
    expect(r.confidence).toBeGreaterThan(0.5);
    expect(r.version).toBe('3.95.30150.0');
  });

  it('Articulate Rise: scormcontent/index.html + lib/main.bundle.js', () => {
    const fileList = ['index.html', 'scormcontent/index.html', 'lib/main.bundle.js', 'course.json'];
    const r = fingerprintAuthoringTool({ fileList });
    expect(r.toolId).toBe('articulate-rise');
  });

  it('Adobe Captivate: html5/captivate/ + CPM.js', () => {
    const fileList = ['index.html', 'html5/captivate/CPM.js', 'assets/css/cp.css', 'goodbye.html'];
    const r = fingerprintAuthoringTool({ fileList });
    expect(r.toolId).toBe('adobe-captivate');
  });

  it('iSpring: ispring_player.html + ispring marker', () => {
    const fileList = ['index.html', 'ispring_player.html', 'data/document.json', 'res/slide1.jpg'];
    const r = fingerprintAuthoringTool({ fileList });
    expect(r.toolId).toBe('ispring');
  });

  it('Lectora: a001index.html', () => {
    const fileList = ['a001index.html', 'a002page.html', 'images/bg.jpg'];
    const r = fingerprintAuthoringTool({ fileList });
    expect(r.toolId).toBe('lectora');
  });

  it('H5P: h5p.json + content/content.json', () => {
    const fileList = ['h5p.json', 'content/content.json', 'H5P.InteractiveVideo-1.22/library.json'];
    const r = fingerprintAuthoringTool({ fileList });
    expect(r.toolId).toBe('h5p');
  });

  it('ranks candidates and reports confidence + signals', () => {
    const fileList = ['story.html', 'story_content/x.js', 'html5/data/js/data.js'];
    const r = fingerprintAuthoringTool({ fileList });
    expect(r.candidates.length).toBeGreaterThanOrEqual(1);
    expect(r.candidates[0].toolId).toBe('articulate-storyline');
    expect(r.signals.length).toBeGreaterThan(0);
    expect(r.signals.every(s => typeof s.weight === 'number')).toBe(true);
  });

  it('manifest-only generator string still fingerprints', () => {
    const x = `<manifest><metadata><schema>ADL SCORM</schema><schemaversion>2004 4th Edition</schemaversion></metadata><!-- Published by iSpring Suite --></manifest>`;
    const r = fingerprintAuthoringTool({ manifestXml: x });
    expect(r.toolId).toBe('ispring');
    expect(r.signals.some(s => s.source === 'manifest')).toBe(true);
  });
});
