/** Security regressions use actual wallet signatures and core signed VCs. */
import {describe,it} from 'vitest';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ethers} from 'ethers';
import {
  createOwnerProfile,createSignedDelegationCredential,ownerProfileToTurtle,delegationCredentialToJsonLd,
  type IRI,type DelegationSigner,type AuthorizedAgentData,
} from '@interego/core';
import {AGENT_REGISTRY_PATH,CREDENTIALS_PATH} from '@interego/solid';
import {WorkbenchDocuments,WorkbenchError,type WorkbenchConfig} from '../src/i2idlx-workbench.js';

const BASE='https://bridge.example',OWNER_ID='u-pk-c0ffee123456',POD='https://pod.example/'+OWNER_ID+'/',SHARED='https://pod.example/u-pk-a11ce1234567/';
const ACTOR='did:web:identity.example:agents:test-'+OWNER_ID;
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const signer=(wallet:ethers.HDNodeWallet):DelegationSigner=>async payload=>({
  signature:await wallet.signMessage(payload),signerAddress:wallet.address,verificationMethod:('did:ethr:'+wallet.address)as IRI,
});
async function fixture(mode:'valid'|'race'|'forged') {
  const ownerWallet=ethers.Wallet.createRandom(),attackerWallet=ethers.Wallet.createRandom();
  const owner=createOwnerProfile(('did:ethr:'+ownerWallet.address)as IRI,'Owner',[]);
  const agent:AuthorizedAgentData={agentId:ACTOR as IRI,delegatedBy:owner.webId,scope:'ReadWrite',validFrom:'2020-01-01T00:00:00Z'};
  const profile={...owner,authorizedAgents:[agent]};
  const validVc=await createSignedDelegationCredential(profile,mode==='race'?{...agent,scope:'ReadOnly'}:agent,POD as IRI,signer(ownerWallet));
  // The persistent forgery claims the real owner while using an attacker
  // proof. The race returns a genuine ReadOnly VC first, then changes its
  // signed scope without updating the proof. Neither is owner authorization.
  const forgedVc=mode==='race'
    ? {...validVc,credentialSubject:{...validVc.credentialSubject,scope:['discover','publish','subscribe']}}
    : await createSignedDelegationCredential(profile,agent,POD as IRI,signer(attackerWallet));
  const path='ballots/'+OWNER_ID,document={v:{}};
  const payload=JSON.stringify({agent_id:ACTOR,timestamp:new Date().toISOString(),i2idlx_operation:'write',bridge_audience:BASE,doc_path:path,document,expected_etag:''});
  const signingWallet=mode==='forged'?attackerWallet:ownerWallet;
  const proof={_signed_payload:payload,_signature:await signingWallet.signMessage('sha256:'+sha(payload))};
  const record={schema:1,path,owner:OWNER_ID,actor:ACTOR,pod:POD,document,proof};
  let credentialReads=0;
  let documentUrl='';
  const config:WorkbenchConfig={
    baseUrl:BASE,sharedPodUrl:SHARED,participantIds:[OWNER_ID],editorDids:[],
    ownerAnchors:{[OWNER_ID]:ownerWallet.address},
    ownPod:actor=>{assert.equal(actor,ACTOR);return POD;},
    verifyCaller:async()=>({ok:false,status:401,error:'Unused on historical reads'}),
    fetch:(async input=>{
      const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
      if(url===POD+AGENT_REGISTRY_PATH)return new Response(ownerProfileToTurtle(profile),{headers:{'Content-Type':'text/turtle'}});
      if(url===POD+CREDENTIALS_PATH+encodeURIComponent(ACTOR)+'.jsonld'){
        credentialReads++;
        const vc=mode==='forged'||(mode==='race'&&credentialReads>1)?forgedVc:validVc;
        return new Response(delegationCredentialToJsonLd(vc),{headers:{'Content-Type':'application/ld+json'}});
      }
      if(url===documentUrl)return new Response(JSON.stringify(record),{headers:{ETag:'"v1"','Content-Type':'application/json'}});
      return new Response(null,{status:404});
    })as typeof fetch,
    encryptionKeypair:()=>null,
  };
  const docs=new WorkbenchDocuments(config);documentUrl=docs.location(path);
  return {docs,path,document,reads:()=>credentialReads};
}
describe('workbench delegated author trust',()=>{
  it('accepts an owner-signed delegation and owner-signed historical document',async()=>{
    const f=await fixture('valid'),read=await f.docs.read(f.path);
    assert.equal(read.exists,true);assert.deepEqual(read.data,f.document);
  });
  it('does not combine a valid read-only VC with an unsigned publish-scope elevation returned by a second read',async()=>{
    const f=await fixture('race');
    await assert.rejects(f.docs.read(f.path),e=>e instanceof WorkbenchError&&e.status===503);
    // One credential snapshot must serve both signature and signer/scope
    // checks. Refetching permits mismatched documents to become one verdict.
    assert.equal(f.reads(),1);
  });
  it('rejects a consistently attacker-signed VC that merely claims the legitimate owner issuer',async()=>{
    const f=await fixture('forged');
    await assert.rejects(f.docs.read(f.path),e=>e instanceof WorkbenchError&&e.status===503);
  });
});
