import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { Pool } from 'pg';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  LEARNING_SCHEMA, PostgresStatementStore, registerLearningMap,
  saveLearningState, restoreLearningState, withLearningTransaction,
  durableLearningMiddleware, closeLearningDatabase, drainLearningOutbox,
} from '../src/postgres-learning-store.js';
import { parseManifest, createSession, processNavigation, commitTracking, type SeqSession } from '../src/scorm-sequencing.js';
import { LtiPlatform } from '../src/lti-platform.js';
import type { StoredStatement } from '../src/statement-store.js';
import { createStatementStore } from '../src/statement-store.js';
import { registerLearningState } from '../src/postgres-learning-store.js';

const record = (id:string=randomUUID(), activity='https://course.example/1'):StoredStatement => ({
  id,stored:'2026-10-03T12:00:00.000Z',voided:false,
  statement:{id,actor:{mbox:'mailto:learner@example.com'},verb:{id:'http://adlnet.gov/expapi/verbs/completed'},object:{id:activity}},
});
const manifest=`<?xml version="1.0"?><manifest identifier="course" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3" xmlns:imsss="http://www.imsglobal.org/xsd/imsss"><organizations default="org"><organization identifier="org"><title>Course</title><item identifier="a" identifierref="ra"><title>A</title></item><item identifier="b" identifierref="rb"><title>B</title></item><imsss:sequencing><imsss:controlMode flow="true" choice="true"/></imsss:sequencing></organization></organizations><resources><resource identifier="ra" type="webcontent" adlcp:scormType="sco" href="a.html"/><resource identifier="rb" type="webcontent" adlcp:scormType="sco" href="b.html"/></resources></manifest>`;
let path:string,db:PGlite,socket:PGLiteSocketServer,pg:Pool;
let originalEnv:string|undefined;
beforeAll(async()=>{
  path=await mkdtemp(join(tmpdir(),'foxxi-durable-'));
  db=await PGlite.create(path);
  // PGlite is only the test database; the production adapter is node-postgres.
  socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:8}); await socket.start();
  originalEnv=process.env.FOXXI_LEARNING_DATABASE_URL;
  process.env.FOXXI_LEARNING_DATABASE_URL=`postgresql://postgres:postgres@${socket.getServerConn()}/postgres`;
  pg=new Pool({connectionString:process.env.FOXXI_LEARNING_DATABASE_URL,max:1});
  await pg.query(LEARNING_SCHEMA);
},30_000);
afterAll(async()=>{
  await closeLearningDatabase(); await pg?.end(); await socket?.stop(); await db?.close();
  if(originalEnv===undefined) delete process.env.FOXXI_LEARNING_DATABASE_URL; else process.env.FOXXI_LEARNING_DATABASE_URL=originalEnv;
  if(path) await rm(path,{recursive:true,force:true});
});

describe('durable LRS records and forwarding',()=>{
  it('reads through a fresh store and isolates identical ids by tenant',async()=>{
    const a=new PostgresStatementStore('test-a',async()=>pg),b=new PostgresStatementStore('test-b',async()=>pg);
    const r=record(); await a.put(r); await b.put(record(r.id,'https://course.example/other'));
    expect(await new PostgresStatementStore('test-a',async()=>pg).get(r.id)).toEqual(r);
    expect((await b.get(r.id))?.statement.object).toEqual({id:'https://course.example/other'});
  });
  it('preserves original authority/timestamp on retries and rejects changed payloads',async()=>{
    const store=new PostgresStatementStore('test-immutability',async()=>pg),r=record(); await store.put(r);
    await store.put({...r,stored:'2026-10-03T13:00:00Z',statement:{...r.statement,stored:'2026-10-03T13:00:00Z',authority:{name:'server'}}});
    expect(await store.get(r.id)).toEqual(r);
    await expect(store.put(record(r.id,'https://changed.example/'))).rejects.toThrow('different body');
  });
  it('keeps records and retry jobs atomic when a surrounding transaction rolls back',async()=>{
    const client=await pg.connect(); const r=record();
    try {await client.query('BEGIN'); await new PostgresStatementStore('test-rollback',async()=>client).put(r); await client.query('ROLLBACK');}
    finally{await client.query('ROLLBACK').catch(()=>undefined);client.release();}
    expect(await new PostgresStatementStore('test-rollback',async()=>pg).get(r.id)).toBeNull();
    expect((await pg.query('SELECT * FROM foxxi_learning_outbox WHERE tenant=$1',['test-rollback'])).rows).toHaveLength(0);
  });
  it('filters queries and preserves voided records through new store instances',async()=>{
    const store=new PostgresStatementStore('test-query',async()=>pg),r=record(); await store.put(r); await store.put(record());
    expect((await store.query({verb:'https://different.example/verb'})).statements).toHaveLength(0);
    expect(await store.markVoided(r.id,randomUUID(),()=>true)).toBe(true);
    expect((await new PostgresStatementStore('test-query',async()=>pg).query({voidedStatementId:r.id})).statements).toHaveLength(1);
  });
  it('does not remove failed delivery jobs, and removes only confirmed deliveries',async()=>{
    const r=record(); await withLearningTransaction(async()=>{await createStatementStore('postgres','outbox-test').put(r);});
    await drainLearningOutbox(async()=>false,100);
    expect((await pg.query('SELECT * FROM foxxi_learning_outbox WHERE tenant=$1',['outbox-test'])).rows).toHaveLength(1);
    await pg.query("UPDATE foxxi_learning_outbox SET next_attempt_at=now() WHERE tenant='outbox-test'");
    await drainLearningOutbox(async tenant=>tenant==='outbox-test',100);
    expect((await pg.query('SELECT * FROM foxxi_learning_outbox WHERE tenant=$1',['outbox-test'])).rows).toHaveLength(0);
  });
});

describe('restartable protocol state',()=>{
  it('restores a real SCORM tree with parent/current references and resumes progression',async()=>{
    const session=createSession('learner',parseManifest(manifest));
    expect(processNavigation(session,'start').ok).toBe(true);
    const map=new Map<string,SeqSession>([[session.id,session]]); registerLearningMap('test:scorm',map);
    await saveLearningState(pg); map.clear(); await restoreLearningState(pg);
    const restored=map.get(session.id)!;
    expect(restored.current).toBe(restored.tree.preorder.find(a=>a.id===restored.current?.id));
    expect(restored.current?.parent).toBe(restored.tree.root);
    expect(commitTracking(restored,{completion:'completed',success:'passed',scoreScaled:1}).ok).toBe(true);
    const advance=processNavigation(restored,'continue'); expect(advance.ok).toBe(true); expect(advance.delivered?.activityId).toBe('b');
  });
  it('keeps buffers, nested Maps and Sets and one-use redemption flags',async()=>{
    const map=new Map<string,unknown>([['token',{redeemed:true,bytes:Buffer.from('attachment'),nested:new Map([['learner',new Set(['au'])]])}]]);
    registerLearningMap('test:tokens-and-binary',map); await saveLearningState(pg); map.clear(); await restoreLearningState(pg);
    const value=map.get('token') as {redeemed:boolean;bytes:Buffer;nested:Map<string,Set<string>>};
    expect(value.redeemed).toBe(true); expect(Buffer.from(value.bytes).toString()).toBe('attachment'); expect(value.nested.get('learner')?.has('au')).toBe(true);
  });
  it('preserves LTI signing identity and the gradebook in a newly constructed platform',async()=>{
    const platform=new LtiPlatform({selfBaseUrl:'https://platform.example'});
    const fresh=new LtiPlatform({selfBaseUrl:'https://platform.example'});
    registerLearningState('test:lti-platform',{collect:()=>platform.durableSnapshot(),restore:value=>fresh.restoreDurableSnapshot(value)});
    await saveLearningState(pg); await restoreLearningState(pg); expect(fresh.jwks()).toEqual(platform.jwks());
  });
  it('rejects corrupted checkpoints rather than interpreting them as empty state',async()=>{
    const map=new Map([['a','saved']]);registerLearningMap('test:corruption',map);await saveLearningState(pg);
    await pg.query("UPDATE foxxi_learning_runtime SET sha256='wrong' WHERE namespace='test:corruption'");
    await expect(restoreLearningState(pg)).rejects.toThrow('integrity failure');
    await pg.query("DELETE FROM foxxi_learning_runtime WHERE namespace='test:corruption'");
  });
  it('rolls back runtime changes when a learning operation throws',async()=>{
    const map=new Map([['a','saved']]);registerLearningMap('test:transaction',map);
    await withLearningTransaction(async()=>undefined);
    await expect(withLearningTransaction(async()=>{map.set('a','unsaved');throw new Error('interrupted');})).rejects.toThrow('interrupted');
    expect(map.get('a')).toBe('saved');
  });
  it('commits state before an HTTP success becomes observable',async()=>{
    const map=new Map<string,string>();registerLearningMap('test:http',map);
    const app=express();app.use(durableLearningMiddleware);
    app.post('/save',(_req,res)=>{map.set('last','committed');res.status(200).json({ok:true});});
    const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
    const port=(server.address() as {port:number}).port;
    try {const response=await fetch(`http://127.0.0.1:${port}/save`,{method:'POST'});expect(response.status).toBe(200);
      map.clear();await restoreLearningState(pg);expect(map.get('last')).toBe('committed');}
    finally{await new Promise<void>(r=>server.close(()=>r()));}
  });
  it('returns 503 and rolls back the LRS and runtime if checkpointing fails after a handler succeeds',async()=>{
    const map=new Map([['state','before']]);registerLearningMap('test:failed-http',map);
    let failing=false;
    registerLearningState('test:fault',{collect:()=>{if(failing)throw new Error('storage fault');return null;},restore:()=>{failing=false;}});
    const r=record();const app=express();app.use(durableLearningMiddleware);
    app.post('/save',async(_req,res)=>{await createStatementStore('postgres','failed-http').put(r);map.set('state','after');failing=true;res.json({ok:true});});
    const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
    try {const response=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/save`,{method:'POST'});
      expect(response.status).toBe(503);expect(map.get('state')).toBe('before');
      expect(await new PostgresStatementStore('failed-http',async()=>pg).get(r.id)).toBeNull();}
    finally{failing=false;await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });

  it('reads persisted statements and an actual SCORM attempt in a separate process after database shutdown',async()=>{
    const session=createSession('cold-learner',parseManifest(manifest));processNavigation(session,'start');
    const map=new Map([[session.id,session]]);registerLearningMap('test:cold-scorm',map);
    const r=record();await withLearningTransaction(async()=>{await createStatementStore('postgres','cold-lrs').put(r);});
    await closeLearningDatabase();await pg.end();await socket.stop();await db.close();
    const code=`import {PGlite} from '@electric-sql/pglite';
      import {deserialize} from 'node:v8';
      import {processNavigation,commitTracking} from './applications/foxxi-content-intelligence/src/scorm-sequencing.ts';
      const db=await PGlite.create(process.argv[1]);
      const rows=await db.query("SELECT record FROM foxxi_learning_statements WHERE tenant='cold-lrs'");
      const state=await db.query("SELECT payload FROM foxxi_learning_runtime WHERE namespace='test:cold-scorm'");
      const sessions=deserialize(Buffer.from(state.rows[0].payload));
      const session=[...sessions.values()][0];
      commitTracking(session,{completion:'completed',success:'passed',scoreScaled:1});
      const next=processNavigation(session,'continue');
      console.log(JSON.stringify({count:rows.rows.length,current:next.delivered?.activityId,refs:session.current===session.tree.preorder.find(a=>a.id===session.current?.id)}));
      await db.close();`;
    const result=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',code,path],{encoding:'utf8',timeout:20_000});
    expect(JSON.parse(result.trim().split('\n').at(-1)!)).toEqual({count:1,current:'b',refs:true});
    db=await PGlite.create(path);socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:8});await socket.start();
    process.env.FOXXI_LEARNING_DATABASE_URL=`postgresql://postgres:postgres@${socket.getServerConn()}/postgres`;
    pg=new Pool({connectionString:process.env.FOXXI_LEARNING_DATABASE_URL,max:1});
  },30_000);

});
