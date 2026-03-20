/**
 * Tests for federation modules: PodDirectory, WebFinger, PodRegistry
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  podDirectoryToTurtle,
  parsePodDirectory,
  resolveWebFinger,
  type PodDirectoryData,
  type IRI,
} from '../src/index.js';
import { PodRegistry } from '../mcp-server/pod-registry.js';

// ── PodDirectory tests ──────────────────────────────────────

describe('PodDirectory', () => {
  const directory: PodDirectoryData = {
    id: 'urn:directory:foxxi' as IRI,
    entries: [
      {
        podUrl: 'https://css-a.example.com/alice/' as IRI,
        owner: 'https://id.example.com/alice/profile#me' as IRI,
        label: "Alice's pod",
      },
      {
        podUrl: 'https://css-b.example.com/bob/' as IRI,
        owner: 'https://id.example.com/bob/profile#me' as IRI,
        label: "Bob's pod",
      },
      {
        podUrl: 'https://corp.internal/org/' as IRI,
        // No owner or label
      },
    ],
  };

  describe('podDirectoryToTurtle', () => {
    it('should serialize a directory to valid Turtle', () => {
      const turtle = podDirectoryToTurtle(directory);

      expect(turtle).toContain('cg:PodDirectory');
      expect(turtle).toContain('cg:hasPod');
      expect(turtle).toContain('https://css-a.example.com/alice/');
      expect(turtle).toContain('https://css-b.example.com/bob/');
      expect(turtle).toContain('https://corp.internal/org/');
      expect(turtle).toContain("Alice's pod");
      expect(turtle).toContain("Bob's pod");
      expect(turtle).toContain('cg:owner');
    });

    it('should include @prefix declarations', () => {
      const turtle = podDirectoryToTurtle(directory);
      expect(turtle).toContain('@prefix cg:');
      expect(turtle).toContain('@prefix rdfs:');
    });
  });

  describe('parsePodDirectory', () => {
    it('should round-trip through serialize → parse', () => {
      const turtle = podDirectoryToTurtle(directory);
      const parsed = parsePodDirectory(turtle);

      expect(parsed.id).toBe('urn:directory:foxxi');
      expect(parsed.entries).toHaveLength(3);

      const alice = parsed.entries.find(e => e.podUrl.includes('alice'));
      expect(alice).toBeDefined();
      expect(alice!.owner).toBe('https://id.example.com/alice/profile#me');
      expect(alice!.label).toBe("Alice's pod");

      const bob = parsed.entries.find(e => e.podUrl.includes('bob'));
      expect(bob).toBeDefined();
      expect(bob!.owner).toBe('https://id.example.com/bob/profile#me');

      const org = parsed.entries.find(e => e.podUrl.includes('corp'));
      expect(org).toBeDefined();
      expect(org!.owner).toBeUndefined();
      expect(org!.label).toBeUndefined();
    });

    it('should handle empty directory', () => {
      const emptyDir: PodDirectoryData = {
        id: 'urn:directory:empty' as IRI,
        entries: [],
      };
      const turtle = podDirectoryToTurtle(emptyDir);
      const parsed = parsePodDirectory(turtle);

      expect(parsed.id).toBe('urn:directory:empty');
      expect(parsed.entries).toHaveLength(0);
    });

    it('should handle malformed Turtle gracefully', () => {
      const parsed = parsePodDirectory('# nothing useful here');
      expect(parsed.id).toBe('urn:directory:unknown');
      expect(parsed.entries).toHaveLength(0);
    });
  });
});

// ── WebFinger tests ─────────────────────────────────────────

describe('WebFinger', () => {

  it('should parse acct: URI domain', async () => {
    const mockFetch = async (url: string) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      text: async () => '',
      json: async () => ({
        subject: 'acct:markj@foxximediums.com',
        links: [
          {
            rel: 'http://www.w3.org/ns/solid/terms#storage',
            href: 'https://pod.foxximediums.com/markj/',
          },
        ],
      }),
    });

    const result = await resolveWebFinger('acct:markj@foxximediums.com', {
      fetch: mockFetch,
    });

    expect(result.subject).toBe('acct:markj@foxximediums.com');
    expect(result.podUrl).toBe('https://pod.foxximediums.com/markj/');
    expect(result.links).toHaveLength(1);
  });

  it('should parse URL-based resource', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      text: async () => '',
      json: async () => ({
        subject: 'https://id.example.com/alice/profile#me',
        links: [
          {
            rel: 'http://www.w3.org/ns/solid/terms#storage',
            href: 'https://pod.example.com/alice/',
          },
          {
            rel: 'self',
            href: 'https://id.example.com/alice/profile#me',
          },
        ],
      }),
    });

    const result = await resolveWebFinger('https://id.example.com/alice/profile#me', {
      fetch: mockFetch,
    });

    expect(result.podUrl).toBe('https://pod.example.com/alice/');
    expect(result.webId).toBe('https://id.example.com/alice/profile#me');
  });

  it('should handle missing pod URL gracefully', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      text: async () => '',
      json: async () => ({
        subject: 'acct:unknown@example.com',
        links: [],
      }),
    });

    const result = await resolveWebFinger('acct:unknown@example.com', {
      fetch: mockFetch,
    });

    expect(result.podUrl).toBeUndefined();
  });

  it('should throw on 404', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: { get: () => null },
      text: async () => '',
      json: async () => ({}),
    });

    await expect(
      resolveWebFinger('acct:nobody@example.com', { fetch: mockFetch }),
    ).rejects.toThrow('404');
  });

  it('should throw on invalid resource', async () => {
    await expect(
      resolveWebFinger('not-a-valid-resource'),
    ).rejects.toThrow('Cannot extract domain');
  });
});

// ── PodRegistry tests ───────────────────────────────────────

describe('PodRegistry', () => {
  let registry: PodRegistry;

  beforeEach(() => {
    registry = new PodRegistry();
  });

  it('should add and retrieve pods', () => {
    registry.add({
      url: 'https://example.com/alice/',
      isHome: true,
      discoveredVia: 'config',
    });

    expect(registry.size).toBe(1);
    expect(registry.get('https://example.com/alice/')!.isHome).toBe(true);
  });

  it('should normalize URLs with trailing slash', () => {
    registry.add({
      url: 'https://example.com/alice',
      isHome: false,
      discoveredVia: 'manual',
    });

    expect(registry.get('https://example.com/alice/')).toBeDefined();
    expect(registry.get('https://example.com/alice')).toBeDefined();
  });

  it('should merge on re-add without overwriting isHome', () => {
    registry.add({
      url: 'https://example.com/alice/',
      isHome: true,
      discoveredVia: 'config',
    });
    registry.add({
      url: 'https://example.com/alice/',
      label: 'Alice',
      isHome: false,
      discoveredVia: 'directory',
    });

    const pod = registry.get('https://example.com/alice/')!;
    expect(pod.isHome).toBe(true); // preserved
    expect(pod.label).toBe('Alice'); // updated
    expect(pod.discoveredVia).toBe('directory'); // updated
  });

  it('should return home pod', () => {
    registry.add({ url: 'https://a.com/', isHome: false, discoveredVia: 'config' });
    registry.add({ url: 'https://b.com/', isHome: true, discoveredVia: 'config' });
    registry.add({ url: 'https://c.com/', isHome: false, discoveredVia: 'config' });

    expect(registry.getHome()!.url).toBe('https://b.com/');
  });

  it('should not remove home pod', () => {
    registry.add({ url: 'https://home.com/', isHome: true, discoveredVia: 'config' });

    const removed = registry.remove('https://home.com/');
    expect(removed).toBe(false);
    expect(registry.size).toBe(1);
  });

  it('should remove non-home pods', () => {
    registry.add({ url: 'https://other.com/', isHome: false, discoveredVia: 'manual' });

    const removed = registry.remove('https://other.com/');
    expect(removed).toBe(true);
    expect(registry.size).toBe(0);
  });

  it('should list all pods', () => {
    registry.add({ url: 'https://a.com/', isHome: true, discoveredVia: 'config' });
    registry.add({ url: 'https://b.com/', isHome: false, discoveredVia: 'directory' });
    registry.add({ url: 'https://c.com/', isHome: false, discoveredVia: 'webfinger' });

    const list = registry.list();
    expect(list).toHaveLength(3);
  });

  it('should track lastSeen via touch', () => {
    registry.add({ url: 'https://a.com/', isHome: false, discoveredVia: 'config' });

    expect(registry.get('https://a.com/')!.lastSeen).toBeUndefined();

    registry.touch('https://a.com/');
    expect(registry.get('https://a.com/')!.lastSeen).toBeDefined();
  });

  it('should track subscriptions', () => {
    const mockSub = { unsubscribe: () => {} };

    registry.add({ url: 'https://a.com/', isHome: false, discoveredVia: 'config' });
    registry.setSubscription('https://a.com/', mockSub);

    expect(registry.get('https://a.com/')!.subscription).toBe(mockSub);
  });

  it('should unsubscribe all', () => {
    let unsubCalled = 0;
    const mockSub = { unsubscribe: () => { unsubCalled++; } };

    registry.add({ url: 'https://a.com/', isHome: false, discoveredVia: 'config' });
    registry.add({ url: 'https://b.com/', isHome: true, discoveredVia: 'config' });
    registry.setSubscription('https://a.com/', mockSub);
    registry.setSubscription('https://b.com/', mockSub);

    registry.unsubscribeAll();
    expect(unsubCalled).toBe(2);
    expect(registry.get('https://a.com/')!.subscription).toBeUndefined();
  });

  it('should auto-add pod on setSubscription if unknown', () => {
    const mockSub = { unsubscribe: () => {} };
    registry.setSubscription('https://unknown.com/', mockSub);

    expect(registry.size).toBe(1);
    expect(registry.get('https://unknown.com/')!.discoveredVia).toBe('manual');
  });
});
