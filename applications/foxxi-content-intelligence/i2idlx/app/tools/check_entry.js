// Exercised by tools/check_app_logic.py: the app's own control recipe, stored-query evaluation, text
// annotation and editorial packet, run under node against the same data.json the page embeds.
import { C, controlsFor } from "../src/data.js";
import { QUERIES, bind, runLocal } from "../src/queries.js";
import { annotate } from "../src/annotate.js";
import { editorialPacket } from "../src/packet.js";
import { classify, SEM, bridgesIn, expand } from "../src/semantic.js";
const out = { controls: {}, queries: {}, selfMatch: {}, packet: "" };
for (const c of C) out.controls[c.id] = Object.fromEntries(controlsFor(c).map((x) => [x.id, x.u]));
for (const q of QUERIES) out.queries[q.name] = { sparql: bind(q, q.sample), result: runLocal(q.name, q.sample) };
for (const c of C) out.selfMatch[c.id] = annotate(c.l, true).map(([a, b, ci]) => [a, b, C[ci].id]);
out.example = annotate("Our learning engineering team is rebuilding the onboarding course. Each activity will send xAPI statements to a Learning Record Store (LRS), and a competency framework will drive adaptive learning.", false).map(([_a, _b, ci]) => C[ci].id);
out.packet = editorialPacket({});
const strip = (r) => ({ ...r, resources: r.resources.map((x) => ({ iri: x.iri, cats: x.cats, classes: x.classes.map((c) => c.t), clashes: x.clashes.map((c) => ({ a: c.a, b: c.b, on: Object.keys(c.why).sort() })), notes: x.notes.map((n) => n.kind), problems: x.problems.map((n) => n.kind) })) });
out.semantic = { example: strip(classify(SEM.example)), clash: strip(classify(SEM.clash)),
  edge: strip(classify(`@prefix i2x: <${SEM.prefixes.i2x}> . @prefix i2idl: <https://id.i2idl.org/concepts/> . @prefix ex: <https://example.org/x/> .
ex:a i2x:isClassifiedBy i2idl:learning-sciences . ex:b i2x:isClassifiedBy i2idl:not-a-concept . ex:c i2x:isClassifiedBy "LRS" .
ex:d i2x:isClassifiedBy i2idl:learning-record-store-lrs , i2idl:classroom-teacher .`)),
  bad: classify("ex:a ex:b") };
// A blank node typed with a peer class that a crosswalk bridges to an I2IDL concept: every inferred line,
// the bridge's i2x:isClassifiedBy included, must name that same blank node.
const peer = [...bridgesIn.keys()].sort()[0];
const bnode = classify(`[] a <${expand(peer)}> .`);
out.semantic.bnode = { peer, concepts: bridgesIn.get(peer).map((b) => b.c), turtle: bnode.turtle };
process.stdout.write(JSON.stringify(out));
