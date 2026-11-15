/**
 * The front door tells a newcomer what they can do, and must not promise what this bridge
 * does not offer: a closed route or an absent affordance is left out of the page.
 */
import { describe, it, expect } from 'vitest';
import { frontDoor, frontDoorHtml } from '../src/front-door.js';
import { foxxiAffordances } from '../affordances.js';

const all = new Set(foxxiAffordances.map(a => a.toolName));
const open = { enabled: true, maxZipMb: 25, perSignerHourly: 5 };
const base = { bridgeUrl: 'https://bridge.example', dashboardUrl: 'https://dash.example', offered: all, openHosting: open };

describe('the front door says only what is offered', () => {
  it('walks a newcomer from no account to bringing a package', () => {
    expect(frontDoor(base).steps.map(s => s.id)).toEqual(['start', 'play', 'record', 'bring']);
  });

  it('points every agent step at an affordance this vertical declares, at its declared target', () => {
    for (const s of frontDoor(base).steps) {
      if (!s.forAgents) continue;
      const declared = foxxiAffordances.find(a => a.toolName === s.forAgents!.affordance);
      expect(declared, s.forAgents.affordance).toBeDefined();
      expect(s.forAgents.target).toBe(declared!.targetTemplate.replace('{base}', base.bridgeUrl));
      expect(s.forAgents.method).toBe(declared!.method);
    }
  });

  it('leaves out bringing a package when the route is closed', () => {
    const d = frontDoor({ ...base, openHosting: { ...open, enabled: false } });
    expect(d.steps.map(s => s.id)).not.toContain('bring');
    expect(frontDoorHtml(d)).not.toContain('Bring a package');
  });

  it('leaves out a step whose affordance is not offered, and the dashboard when there is none', () => {
    const d = frontDoor({ bridgeUrl: base.bridgeUrl, offered: new Set(['foxxi.cmi5_launch_signed']), openHosting: open });
    expect(d.steps.map(s => s.id)).toEqual(['play']);
  });

  it('states the bounds on what may be brought', () => {
    const bring = frontDoor({ ...base, openHosting: { enabled: true, maxZipMb: 10, perSignerHourly: 2 } }).steps.find(s => s.id === 'bring')!;
    expect(bring.forPeople).toContain('10 MB');
    expect(bring.forPeople).toContain('2 packages an hour');
  });

  it('escapes what it is given and loads nothing from elsewhere', () => {
    const html = frontDoorHtml(frontDoor({ ...base, dashboardUrl: 'https://dash.example/"><script>x</script>' }));
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/<link|src=/);
  });
});
