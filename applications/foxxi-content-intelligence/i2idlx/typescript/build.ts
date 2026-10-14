/**
 * Opt-in native I2IDL-X build. Python remains an independent parity oracle.
 * Every report is computed from this build; no previous dist report is copied.
 */
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, DataFactory } from 'n3';
import { DEFAULT_ROOT } from './config.js';
import { generate, type BuildResult } from './generate.js';
import { validateBuild, type BuildVerification } from './verification.js';
import { materializeDecorations, writeDecorations } from './decorations.js';
import { serializeTurtle } from './rdf.js';
import { shaclValidate } from './validation.js';
import { buildApp } from './build-app.js';
import { checkAppData } from './check-app-data.js';
import { buildSite } from './build-site.js';
import { publicationRecord } from './publication-record.js';
import { agentWalk } from './agent-walk.js';
import { progressStage } from './progress.js';

const { namedNode: nn, literal, quad } = DataFactory;
const RDF='http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const PROV='http://www.w3.org/ns/prov#';
const XSD='http://www.w3.org/2001/XMLSchema#';
export interface NativeBuildOptions {
  outputDir?: string; appDir?: string; siteDir?: string;
  graphsOnly?: boolean; skipHermit?: boolean; workbenchUrl?: string;
}
async function workedExamples(build: BuildResult): Promise<string[]> {
  const directory=join(build.outputDir,'examples');
  await mkdir(directory,{recursive:true});
  const graphs=new Map<string,Store>();
  const statement: {
    id:string; context:{extensions:Record<string,string[]>};
    verb:{id:string}; object:{id:string}; timestamp:string;
  }=JSON.parse(await readFile(join(build.root,'examples','usage-statement.json'),'utf8'));
  const tags=statement.context.extensions['https://foxxi-bridge.interego.xwisee.com/ns/foxxi#conceptIds'];
  if(!tags?.length||!tags.every(t=>build.concepts.has(t)))throw new Error('Usage statement tags an absent I2IDL concept');
  const graph=new Store(),record=nn('urn:example:usage:'+statement.id.split('-')[0]!);
  graph.addQuad(quad(record,nn(RDF+'type'),nn(build.NS+'UsageRecord')));
  graph.addQuad(quad(record,nn(build.NS+'statement'),nn('urn:uuid:'+statement.id)));
  graph.addQuad(quad(record,nn(build.NS+'usageVerb'),nn(statement.verb.id)));
  graph.addQuad(quad(record,nn(build.NS+'usageActivity'),nn(statement.object.id)));
  graph.addQuad(quad(record,nn('https://markjspivey-xwisee.github.io/interego/ns/interego#forAgent'),nn('urn:example:learner')));
  graph.addQuad(quad(record,nn(PROV+'generatedAtTime'),literal(statement.timestamp,nn(XSD+'dateTime'))));
  for(const tag of tags)graph.addQuad(quad(record,nn(build.NS+'aboutConcept'),nn(tag)));
  graphs.set('usage-record.ttl',graph);
  await writeFile(join(directory,'usage-record.ttl'),await serializeTurtle(graph,{i2x:build.NS}));
  await writeFile(join(directory,'usage-statement.json'),JSON.stringify(statement,null,2)+'\n');
  const { Parser }=await import('n3');
  for(const file of (await readdir(join(build.root,'examples'))).filter(f=>f.endsWith('.ttl')||f.endsWith('.ttl.tmpl')).sort()) {
    const name=file.replace(/\.tmpl$/,'');
    const text=build.render(await readFile(join(build.root,'examples',file),'utf8'));
    graphs.set(name,new Store(new Parser({format:'Turtle'}).parse(text)));
    await writeFile(join(directory,name),text);
  }
  const checks:string[]=[],voted=new Set<string>();
  for(const [name,g]of graphs) {
    const result=await shaclValidate(g,build.graphs.shapes!,{ontology:build.graphs.ontology!,inference:'rdfs'});
    if(!result.conforms)throw new Error('Worked example '+name+' fails SHACL: '+result.text);
    checks.push('- PASS — example '+name+' conforms ('+g.size+' triples)');
    for(const q of g.getQuads(null,nn(build.NS+'votesOn'),null,null))voted.add(q.object.value);
  }
  const open=new Set(build.graphs.mappings!.getQuads(null,nn(build.NS+'reviewStatus'),nn(build.NS+'status-proposed'),null).map(q=>q.subject.value));
  if(![...voted].every(v=>open.has(v)))throw new Error('Example vote targets a proposal that is not open');
  checks.push('- PASS — every example vote targets an open mapping proposal');
  return checks;
}
export async function buildNative(root=DEFAULT_ROOT,options:NativeBuildOptions={}):Promise<{build:BuildResult;verification:BuildVerification}> {
  root=resolve(root);
  const build=await progressStage('native:generate',()=>generate(root,{outputDir:resolve(options.outputDir??join(root,'dist-ts'))}));
  const verification=await progressStage('native:validate',()=>validateBuild(build,{skipHermit:options.skipHermit}));
  const decorations=await progressStage('native:decorations',()=>materializeDecorations(build,verification.inferred));
  if(decorations.affordances!==5*build.concepts.size||decorations.inherited.size===0)throw new Error('Per-concept decorations are incomplete');
  const decorationShapes=await progressStage('native:decorations-shacl',()=>shaclValidate(decorations.graph,build.graphs.shapes!,{ontology:build.graphs.ontology!,inference:'rdfs'}));
  if(!decorationShapes.conforms)throw new Error('Materialized decorations fail SHACL: '+decorationShapes.text);
  writeDecorations(build,decorations);
  const examples=await progressStage('native:worked-examples',()=>workedExamples(build));
  const report=verification.report+'\n## Worked examples\n'+examples.join('\n')+'\n\n- PASS — '+decorations.affordances+' concrete affordances materialized\n';
  await writeFile(join(build.outputDir,'verification-report.md'),report);
  if(!options.graphsOnly) {
    const appDir=resolve(options.appDir??join(root,'app','build-ts'));
    const siteDir=resolve(options.siteDir??join(root,'site-ts'));
    const receipts=await progressStage('native:publication-receipts',()=>publicationRecord(root,{outputDir:build.outputDir}));
    if(receipts.problems.length)throw new Error('Publication receipts failed: '+receipts.problems.join('; '));
    await progressStage('native:agent-walk',()=>agentWalk(root,{distDir:build.outputDir,live:false}));
    await progressStage('native:build-app',()=>buildApp(root,{distDir:build.outputDir,outputDir:appDir,siteDir,now:process.env.I2IDLX_NOW}));
    checkAppData(join(appDir,'data.json'));
    await progressStage('native:build-site',()=>buildSite(root,{distDir:build.outputDir,outputDir:siteDir,appDir,workbenchUrl:options.workbenchUrl}));
  }
  return {build,verification};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const args=process.argv.slice(2);
  const root=args[0]&&!args[0].startsWith('--')?args.shift()!:DEFAULT_ROOT;
  const options:NativeBuildOptions={};
  while(args.length) {
    const key=args.shift()!;
    if(key==='--graphs-only')options.graphsOnly=true;
    else if(key==='--skip-hermit')options.skipHermit=true;
    else {
      const value=args.shift();if(!value||value.startsWith('--'))throw new Error('Missing value for '+key);
      if(key==='--out')options.outputDir=value;
      else if(key==='--app-out')options.appDir=value;
      else if(key==='--site-out')options.siteDir=value;
      else if(key==='--workbench-url')options.workbenchUrl=value;
      else throw new Error('Unknown argument '+key);
    }
  }
  await buildNative(root,options);
}
