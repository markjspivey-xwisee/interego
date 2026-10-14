import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { shareUrlBootstrap } from './build-app.js';

const archive = 'https://claude.ai/artifact/retained-archive';
test('share URLs use the current hosted origin and canonical workbench route', () => {
  const window = { location: { href: 'https://preview.example.org/i2idlx/reference?draft=1#record' } } as { location: { href: string }; __APP_URL__?: string; __ARCHIVED_APP_URL__?: string };
  vm.runInNewContext(shareUrlBootstrap(archive), { window, URL });
  assert.equal(window.__APP_URL__, 'https://preview.example.org/i2idlx/');
  assert.equal(window.__ARCHIVED_APP_URL__, archive);
});
test('a legacy Claude artifact retains its original share URL', () => {
  const window = { claude: {}, location: { href: 'https://legacy.example.org/embedded-frame' } } as { claude: object; location: { href: string }; __APP_URL__?: string; __ARCHIVED_APP_URL__?: string };
  vm.runInNewContext(shareUrlBootstrap(archive), { window, URL });
  assert.equal(window.__APP_URL__, archive);
  assert.equal(window.__ARCHIVED_APP_URL__, archive);
});
test('archived metadata cannot terminate its inline script', () => {
  const script = shareUrlBootstrap('https://example.org/</script><!--retained');
  assert.ok(!script.includes('</script>'));
  assert.ok(!script.includes('<!--'));
  const window = { location: { href: 'https://preview.example.org/current' } } as { location: { href: string }; __APP_URL__?: string; __ARCHIVED_APP_URL__?: string };
  vm.runInNewContext(script, { window, URL });
  assert.equal(window.__APP_URL__, 'https://preview.example.org/i2idlx/');
  assert.equal(window.__ARCHIVED_APP_URL__, 'https://example.org/</script><!--retained');
});
