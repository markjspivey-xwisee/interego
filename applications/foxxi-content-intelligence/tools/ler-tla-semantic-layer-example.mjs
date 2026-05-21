#!/usr/bin/env node
/**
 * IEEE-LER + ADL-TLA emergent composable semantic layer — live demo.
 *
 * Dereferences the two ontologies the foxxi bridge serves and prints how
 * the LER / TLA standards families are modelled as compositions over the
 * Interego substrate: which terms are genuinely new vocabulary, and
 * which emerge as aggregations / views / roles over substrate primitives.
 *
 * This is not a parser of static files — it does real HTTP GETs against
 * the bridge, proving the layer is dereferenceable linked data.
 *
 *   BRIDGE=https://interego-foxxi-bridge.<...>.azurecontainerapps.io \
 *     node tools/ler-tla-semantic-layer-example.mjs
 *
 * Defaults to http://localhost:6090.
 */

const BRIDGE = process.env.BRIDGE ?? 'http://localhost:6090';

async function getJson(url, accept = 'application/ld+json') {
  const r = await fetch(url, { headers: { Accept: accept } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.json();
}
async function getText(url, accept) {
  const r = await fetch(url, { headers: { Accept: accept } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}

function bar(n, max, width = 28) {
  const filled = max > 0 ? Math.round((n / max) * width) : 0;
  return '█'.repeat(filled) + '·'.repeat(width - filled);
}

async function main() {
  console.log(`\n  IEEE-LER + ADL-TLA emergent composable semantic layer`);
  console.log(`  bridge: ${BRIDGE}\n`);

  for (const [slug, title] of [['ieee-ler', 'IEEE Learning & Employment Records'],
                               ['adl-tla', 'ADL Total Learning Architecture']]) {
    const url = `${BRIDGE}/ns/${slug}`;
    const doc = await getJson(url);
    const terms = doc.terms ?? [];
    const byConstruction = {};
    for (const t of terms) {
      const c = t.construction ?? 'concept';
      byConstruction[c] = (byConstruction[c] ?? 0) + 1;
    }
    console.log(`  ── ${title}`);
    console.log(`     ${url}  (${terms.length} terms)\n`);
    const order = ['minted', 'composed', 'view', 'role', 'concept'];
    const max = Math.max(...Object.values(byConstruction), 1);
    for (const c of order) {
      const n = byConstruction[c] ?? 0;
      if (n === 0) continue;
      console.log(`     ${c.padEnd(9)} ${bar(n, max)} ${n}`);
    }
    // Show a few composed/view terms with the primitives they emerge from.
    const composed = terms.filter(t => ['composed', 'view'].includes(t.construction)).slice(0, 4);
    if (composed.length) {
      console.log(`\n     emergent — composed/view terms name their substrate primitives:`);
      for (const t of composed) {
        const from = (t.constructedFrom ?? []).join(', ');
        console.log(`       ${(t.label ?? t['@id']).padEnd(34)} ⇐ ${from}`);
      }
    }
    console.log();
  }

  // Cross-standard composition: the two families share identity.
  const ler = await getJson(`${BRIDGE}/ns/ieee-ler`);
  const equivalences = (ler.terms ?? [])
    .filter(t => Array.isArray(t.equivalentClass) && t.equivalentClass.length)
    .map(t => `${t.label}  ≡  ${t.equivalentClass.join(', ')}`);
  console.log(`  ── cross-standard identity (owl:equivalentClass) — the two`);
  console.log(`     families compose into one federated layer:\n`);
  for (const e of equivalences) console.log(`     ${e}`);

  // Prove a single term IRI and the Turtle serialization both resolve.
  const term = await getJson(`${BRIDGE}/ns/ieee-ler/term/EnterpriseLearnerRecord`);
  const ttl = await getText(`${BRIDGE}/ns/adl-tla`, 'text/turtle');
  console.log(`\n  ── dereferenceability check`);
  console.log(`     ler:EnterpriseLearnerRecord  -> ${term['@type']} (${term.construction})`);
  console.log(`     adl-tla Turtle               -> ${ttl.split('\n').length} lines, ` +
    `${(ttl.match(/cg:constructedFrom/g) ?? []).length} cg:constructedFrom triples`);
  console.log(`\n  OK — the semantic layer is live, dereferenceable linked data.\n`);
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
