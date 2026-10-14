import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export interface BuildConfig {
  relayNsRoot: string; owner: string; slugs: Record<string, string>;
  i2idl: {release: string; repo: string; localClone: string; graphPath: string};
  foxxiManifest: string;
  foxxiNs: {version: string; base: string; archive: string; modules: string[]; sha256: Record<string, string>};
  reasoner: {name: string; url: string; sha256: string; jar: string};
  version: string; interegoCoreSrc: string; tsx: string; appArtifactUrl?: string; archivedAppArtifactUrl?: string;
}
export const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
export function loadConfig(root = DEFAULT_ROOT): BuildConfig {
  const cfg: BuildConfig = JSON.parse(readFileSync(resolve(root, 'config.json'), 'utf8'));
  const path = (value: string, env: string): string => {
    const selected = process.env[env] || value;
    return selected && !isAbsolute(selected) ? resolve(root, selected) : selected;
  };
  cfg.i2idl.localClone = path(cfg.i2idl.localClone, 'I2IDL_CLONE');
  cfg.interegoCoreSrc = path(cfg.interegoCoreSrc, 'INTEREGO_CORE_SRC');
  cfg.tsx = path(cfg.tsx, 'INTEREGO_TSX');
  cfg.reasoner.jar = path(cfg.reasoner.jar, 'I2IDLX_REASONER_JAR');
  return cfg;
}
export function namespaceIris(cfg: BuildConfig): {BASE: string; IRI: Record<string, string>; NS: string} {
  const BASE = cfg.relayNsRoot + '/' + cfg.owner;
  const IRI = Object.fromEntries(Object.entries(cfg.slugs).map(([key, slug]) => [key, BASE + '/' + slug]));
  return {BASE, IRI, NS: IRI.ontology + '#'};
}
