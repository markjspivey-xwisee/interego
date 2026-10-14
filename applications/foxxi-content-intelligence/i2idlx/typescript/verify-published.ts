/**
 * Fetch each public graph through real HTTP content negotiation and compare
 * both RDF representations to the native build through independent URDNA2015
 * canonicalization. HyperMarkdown must also resolve as a nonempty document.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROOT } from './config.js';
import { rdfFingerprint } from './parity.js';
import { parseTurtle, parseJsonLd } from './rdf.js';
import { fetchDocument, loadPublicationPlan, publicationCliOptions, type FetchDocument } from './publication-io.js';
export interface RepresentationCheck {
  status:number|null;contentType:string|null;bytes:number;triples?:number;isomorphic?:boolean;
  fingerprint?:string;error?:string;
}
export interface PublishedGraphCheck {
  slug:string;graphIri:string;localTriples:number;localFingerprint:string;
  turtle:RepresentationCheck;jsonld:RepresentationCheck;markdown:RepresentationCheck;
}
export interface PublishedVerification {checkedAt:string;algorithm:string;graphs:PublishedGraphCheck[];failed:string[];ok:boolean}
export async function verifyPublished(root=DEFAULT_ROOT,options:{outputDir?:string;only?:string[];write?:boolean;fetcher?:FetchDocument}={}):Promise<PublishedVerification> {
  const {plan,outputDir}=loadPublicationPlan(root,options.outputDir),fetcher=options.fetcher||fetchDocument;
  const valid=new Set(plan.graphs.map(g=>g.graph_iri.split('/').pop()!)),only=new Set(options.only||[]);
  for(const slug of only)if(!valid.has(slug))throw Error('Unknown public graph selection '+slug);
  const failed:string[]=[],graphs:PublishedGraphCheck[]=[];
  for(const row of plan.graphs) {
    const slug=row.graph_iri.split('/').pop()!;if(only.size&&!only.has(slug))continue;
    const local=readFileSync(join(outputDir,row.file),'utf8'),localGraph=parseTurtle(local,row.graph_iri);
    const localFingerprint=await rdfFingerprint(local,'turtle',row.graph_iri);
    const checks={} as Record<'turtle'|'jsonld'|'markdown',RepresentationCheck>;
    for(const [format,accept]of [['turtle','text/turtle'],['jsonld','application/ld+json'],['markdown','text/markdown']] as const) {
      const check:RepresentationCheck={status:null,contentType:null,bytes:0};checks[format]=check;
      try {
        const response=await fetcher(row.graph_iri,accept,'i2idlx-verify/1.0');
        check.status=response.status;check.contentType=response.contentType;check.bytes=Buffer.byteLength(response.body,'utf8');
        if(response.status!==200)throw Error('HTTP '+response.status);
        const media=format==='turtle'?['text/turtle','application/x-turtle']:format==='jsonld'?['application/ld+json']:['text/markdown','text/x-markdown'];
        if(!media.includes(response.contentType))throw Error('Unexpected negotiated media type '+response.contentType);
        if(!response.body.trim())throw Error('Negotiated document is empty');
        if(format==='turtle'||format==='jsonld') {
          const remote=format==='turtle'?parseTurtle(response.body,response.url):await parseJsonLd(JSON.parse(response.body),response.url);
          check.triples=remote.size;
          check.fingerprint=await rdfFingerprint(response.body,format,response.url);
          check.isomorphic=check.fingerprint===localFingerprint;
          if(!check.isomorphic)throw Error('Remote RDF graph differs from local build');
        }
      } catch(error) {check.error=error instanceof Error?error.message:String(error);failed.push(slug+' ('+format+')');}
    }
    graphs.push({slug,graphIri:row.graph_iri,localTriples:localGraph.size,localFingerprint,
      turtle:checks.turtle,jsonld:checks.jsonld,markdown:checks.markdown});
  }
  if(!graphs.length)throw Error('No public graph was selected for verification');
  const result:PublishedVerification={checkedAt:new Date().toISOString(),algorithm:'URDNA2015 / SHA-256',graphs,failed,ok:failed.length===0};
  if(options.write!==false)writeFileSync(join(outputDir,'published-verification.json'),JSON.stringify(result,null,2)+'\n');
  return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=publicationCliOptions(process.argv.slice(2));
    const result=await verifyPublished(args.root||DEFAULT_ROOT,{outputDir:args.outputDir,only:args.only});
    for(const graph of result.graphs)process.stdout.write(JSON.stringify(graph)+'\n');
    process.stdout.write(result.ok?'ok: Turtle and JSON-LD isomorphic to the build; HyperMarkdown resolves\n':'FAIL: '+result.failed.join(', ')+'\n');
    if(!result.ok)process.exitCode=1;
  } catch(error) {process.stderr.write((error instanceof Error?error.stack:String(error))+'\n');process.exitCode=1;}
}
