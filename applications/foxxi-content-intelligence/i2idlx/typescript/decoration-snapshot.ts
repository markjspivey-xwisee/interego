/** Freeze the five signed-publication inputs from the shared decorator kit. */
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DECORATIONS } from '../../src/decorations/index.js';
import { catalogGraph, proposalsGraph, turtleOf, jsonLdOf, checkDecoration,
  decorationIri, proposalsIri } from '../../src/decorations/kit.js';
import { loadConfig, namespaceIris, DEFAULT_ROOT } from './config.js';
import { rdfFingerprint } from './parity.js';

export async function decorationSnapshot(root=DEFAULT_ROOT,outputFile?:string):Promise<Record<string,unknown>> {
  const cfg=loadConfig(root),{BASE}=namespaceIris(cfg);
  const bridge='https://foxxi-bridge.interego.xwisee.com';
  const graphs:Record<string,unknown>[]=[];
  for(const spec of Object.values(DECORATIONS)) {
    const problems=checkDecoration(spec);if(problems.length)throw new Error(spec.id+': '+problems.join('; '));
    for(const kind of ['catalog','proposals'] as const) {
      const graph=kind==='catalog'?catalogGraph(spec,bridge,BASE):proposalsGraph(spec,bridge,BASE);
      const turtle=turtleOf(graph,spec,kind),jsonld=JSON.stringify(jsonLdOf(graph));
      const iri=kind==='catalog'?decorationIri(bridge,spec.id,BASE):proposalsIri(bridge,spec.id,BASE);
      const fingerprint=await rdfFingerprint(turtle,'turtle',iri);
      if(fingerprint!==await rdfFingerprint(jsonld,'jsonld',iri))throw new Error(iri+' serialization is not isomorphic');
      graphs.push({id:spec.id,kind,iri,modal:kind==='catalog'?'Asserted':'Hypothetical',fingerprint,turtle,jsonld});
    }
  }
  const snapshot={owner:cfg.owner,bridge,canonicalBase:BASE,commit:process.env.GITHUB_SHA??null,graphs};
  if(outputFile){await mkdir(resolve(outputFile,'..'),{recursive:true});await writeFile(outputFile,JSON.stringify(snapshot,null,2)+'\n');}
  return snapshot;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const snapshot=await decorationSnapshot(DEFAULT_ROOT,join(DEFAULT_ROOT,'dist-ts','decoration-snapshot.json'));
  process.stdout.write('I2IDLX_DECORATION_SNAPSHOT='+JSON.stringify(snapshot)+'\n');
}
