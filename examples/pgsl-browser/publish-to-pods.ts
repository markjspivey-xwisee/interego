#!/usr/bin/env tsx
/**
 * Publish descriptors to real Solid pods and verify cross-pod discovery.
 * Requires CSS running at localhost:3456 and browser at localhost:5000.
 */
import { ContextDescriptor, publish, discover } from '@interego/core';
import type { IRI, FetchFn } from '@interego/core';

const solidFetch: FetchFn = async (url, init) => {
  const resp = await fetch(url, init as RequestInit);
  return { ok: resp.ok, status: resp.status, statusText: resp.statusText,
    headers: { get: (n: string) => resp.headers.get(n) },
    text: () => resp.text(), json: () => resp.json() };
};

async function main() {
  console.log('Publishing to real Solid pods...\n');

  // ER → pod
  const erDesc = ContextDescriptor.create('urn:cg:er:patient-47-visit' as IRI)
.describes('urn:graph:er:patient-47' as IRI)
.temporal({ validFrom: '2026-04-05T08:00:00Z', validUntil: '2026-04-05T20:00:00Z' })
.provenance({ wasGeneratedBy: { agent: 'urn:system:er:triage' as IRI, startedAt: '2026-04-05T08:00:00Z' }, wasAttributedTo: 'did:web:er.hospital.org' as IRI, generatedAtTime: '2026-04-05T08:05:00Z' })
.agent('did:web:er.hospital.org' as IRI, 'ER Physician')
.semiotic({ modalStatus: 'Asserted', epistemicConfidence: 0.85 })
.trust({ trustLevel: 'SelfAsserted', issuer: 'did:web:er.hospital.org' as IRI })
.build();
  const erPub = await publish(erDesc, '<urn:patient:47> <urn:condition> "chest-pain". <urn:patient:47> <urn:status> "critical". <urn:patient:47> <urn:heart-rate> "120".', 'http://localhost:3456/er/', { fetch: solidFetch });
  console.log('  ER published:', erPub.descriptorUrl);

  // Lab → pod
  const labDesc = ContextDescriptor.create('urn:cg:lab:patient-47-results' as IRI)
.describes('urn:graph:lab:patient-47' as IRI)
.temporal({ validFrom: '2026-04-05T09:30:00Z', validUntil: '2026-04-06T09:30:00Z' })
.provenance({ wasGeneratedBy: { agent: 'urn:system:lab:analyzer' as IRI, startedAt: '2026-04-05T09:30:00Z' }, wasAttributedTo: 'did:web:lab.hospital.org' as IRI, generatedAtTime: '2026-04-05T09:45:00Z', sources: ['urn:cg:er:patient-47-visit' as IRI] })
.agent('did:web:lab.hospital.org' as IRI, 'Lab System')
.semiotic({ modalStatus: 'Asserted', epistemicConfidence: 0.95 })
.trust({ trustLevel: 'ThirdPartyAttested', issuer: 'did:web:lab.hospital.org' as IRI })
.build();
  const labPub = await publish(labDesc, '<urn:patient:47> <urn:troponin> "elevated". <urn:patient:47> <urn:metabolic-panel> "normal". <urn:patient:47> <urn:blood-type> "A-positive".', 'http://localhost:3456/lab/', { fetch: solidFetch });
  console.log('  Lab published:', labPub.descriptorUrl);

  // Pharmacy → pod
  const pharmaDesc = ContextDescriptor.create('urn:cg:pharmacy:patient-47-meds' as IRI)
.describes('urn:graph:pharmacy:patient-47' as IRI)
.temporal({ validFrom: '2026-04-05T08:15:00Z' })
.provenance({ wasGeneratedBy: { agent: 'urn:system:pharmacy:dispenser' as IRI, startedAt: '2026-04-05T08:15:00Z' }, wasAttributedTo: 'did:web:pharmacy.hospital.org' as IRI, generatedAtTime: '2026-04-05T08:20:00Z' })
.agent('did:web:pharmacy.hospital.org' as IRI, 'Pharmacist')
.semiotic({ modalStatus: 'Asserted', epistemicConfidence: 0.99, groundTruth: true })
.trust({ trustLevel: 'CryptographicallyVerified', issuer: 'did:web:pharmacy.hospital.org' as IRI })
.build();
  const pharmaPub = await publish(pharmaDesc, '<urn:patient:47> <urn:prescribed> "aspirin 325mg". <urn:patient:47> <urn:prescribed> "heparin drip". <urn:patient:47> <urn:allergy> "penicillin".', 'http://localhost:3456/pharmacy/', { fetch: solidFetch });
  console.log('  Pharmacy published:', pharmaPub.descriptorUrl);

  // Cross-pod discovery
  console.log('\n=== Cross-Pod Discovery ===');
  for (const [name, url] of [['ER', 'http://localhost:3456/er/'], ['Lab', 'http://localhost:3456/lab/'], ['Pharmacy', 'http://localhost:3456/pharmacy/']] as const) {
    const entries = await discover(url, undefined, { fetch: solidFetch });
    console.log(`  ${name}: ${entries.length} descriptor(s)`);
    for (const e of entries) console.log(`    → ${e.describes[0]} | ${e.facetTypes.join(', ')}`);
  }

  // Trigger browser discovery
  console.log('\n=== Browser Discovery ===');
  for (const url of ['http://localhost:3456/er/', 'http://localhost:3456/lab/', 'http://localhost:3456/pharmacy/']) {
    await fetch('http://localhost:5000/api/pods/discover', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({url}) });
  }
  const pods = await (await fetch('http://localhost:5000/api/pods')).json();
  console.log(`  ${pods.totalPods} pods, ${pods.totalDescriptors} descriptors`);
  for (const p of pods.pods) console.log(`    ${p.name}: ${p.descriptorCount} desc (${p.status})`);

  // Identity server
  console.log('\n=== Identity Server ===');
  try {
    const health = await (await fetch('http://localhost:8090/health')).json();
    console.log(`  Status: ${health.status} | Users: ${health.users} | Agents: ${health.agents}`);
    const did = await (await fetch('http://localhost:8090/.well-known/did.json')).json();
    console.log(`  Server DID: ${did.id}`);
  } catch { console.log('  (identity server not responding)'); }

  console.log('\n=== Full System Running ===');
  console.log('  Browser:      http://localhost:5000/');
  console.log('  Observatory:  http://localhost:5000/observatory');
  console.log('  CSS (Solid):  http://localhost:3456/');
  console.log('  ER Pod:       http://localhost:3456/er/');
  console.log('  Lab Pod:      http://localhost:3456/lab/');
  console.log('  Pharmacy Pod: http://localhost:3456/pharmacy/');
  console.log('  Identity:     http://localhost:8090/');
  console.log('\n  Observatory shows all layers: Federation tab → SPARQL tab → SHACL tab → Coherence tab');
}

main().catch(e => { console.error(e); process.exit(1); });
