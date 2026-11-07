// Navigation targets are a projection. Semantic IRIs and canonical data stay intact.
export function safeHttpHref(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/.test(value)) return undefined;
  let parsed;
  try { parsed = new URL(value); } catch { return undefined; }
  if (parsed.username || parsed.password) return undefined;
  const lower = value.toLowerCase();
  let suffix, prefix;
  if (parsed.protocol === 'https:' && lower.startsWith('https://')) { prefix = 'https://'; suffix = value.slice(8); }
  else if (parsed.protocol === 'http:' && lower.startsWith('http://')) { prefix = 'http://'; suffix = value.slice(7); }
  else return undefined;
  // Encode HTML metacharacters as URL bytes, without double-encoding existing
  // percent escapes or changing query separators. The fixed prefix forbids script URLs.
  return prefix + suffix.replace(/[<>"']/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
}

export function safeNavigationHref(value) {
  // The workbench's native fragment grammar: encoding leaves every valid token unchanged.
  if (typeof value === 'string' && /^#[A-Za-z0-9._~-]*$/.test(value)) return '#' + encodeURIComponent(value.slice(1));
  return safeHttpHref(value);
}
