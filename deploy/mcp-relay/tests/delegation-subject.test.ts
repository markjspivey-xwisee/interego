#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { Wallet, verifyMessage } from 'ethers';
import {
  createOwnerProfile, createSignedDelegationCredential, delegationCredentialToJsonLd,
  createSignedAuthorship, verifySignedAuthorship, canonicalGraphDigest,
  ownerProfileToTurtle, removeAuthorizedAgent, proofBindsToDescriptorUrl,
  type IRI, type AuthorizedAgentData, type DelegationSigner, type DelegationVerifier,
} from '@interego/core';
import { buildAuthorshipProofBlock, parseAuthorshipProofFromDescriptorTurtle } from '@interego/solid';
import type { FetchFn } from '@interego/core/http';
import { verifyPrincipalDelegation } from '../principal-delegation.js';
import { authorshipVerdict } from '../authorship-content-binding.js';
import { selectDelegationSubject, cacheDelegationSubject, equivalentDelegationSubjects, canAutoRegisterPrincipal } from '../delegation-subject.js';
const ID='https://identity.interego.xwisee.com';
const slug='chatgpt-u-pk-731e988c2c5b';
const did='did:web:identity.interego.xwisee.com:agents:'+slug;
const alias=selectDelegationSubject(did,[{agentId:slug}],ID);
assert.equal(alias.registered,slug);
assert.equal(alias.basis,'identity-alias');
assert.equal(cacheDelegationSubject(true,alias),false,'a legacy grant is reread after every owner change');
assert.equal(canAutoRegisterPrincipal(true,alias),false,'own-pod provisioning cannot overwrite an existing legacy scope ceiling');
const exact=selectDelegationSubject(did,[{agentId:slug},{agentId:did}],ID);
assert.equal(exact.registered,did,'an exact canonical row wins independently of its scope or revocation');
assert.equal(cacheDelegationSubject(true,exact),true);
assert.equal(canAutoRegisterPrincipal(true,exact),false);
assert.equal(canAutoRegisterPrincipal(false,selectDelegationSubject(did,[],ID)),false);
assert.equal(canAutoRegisterPrincipal(true,selectDelegationSubject(did,[],ID)),true);
assert.equal(cacheDelegationSubject(false,exact),false);
assert.equal(selectDelegationSubject('did:web:attacker.test:agents:'+slug,[{agentId:slug}],ID).basis,'missing','a foreign DID authority is not the same agent');
assert.equal(selectDelegationSubject('did:web:identity.interego.xwisee.com:another:'+slug,[{agentId:slug}],ID).basis,'missing','a DID suffix alone never binds a grant');
assert.equal(selectDelegationSubject(did,[{agentId:'../'+slug}],ID).basis,'missing','path-shaped aliases are refused');
assert.equal(selectDelegationSubject(did,[{agentId:slug},{agentId:slug}],ID).basis,'ambiguous','duplicate alias rows cannot choose a grant');
assert.equal(selectDelegationSubject(did,[],ID).basis,'missing');
assert.equal(selectDelegationSubject('did:key:z6MkOther',[{agentId:'did:key:z6MkOther'}],ID).basis,'exact','other exact IRI registrations keep their existing semantics');
assert.equal(selectDelegationSubject(slug,[{agentId:slug}],ID).basis,'exact','legacy exact-subject callers retain existing behavior');
process.stdout.write('Delegation subject identity and cache invariants passed\n');

/** Real secp256k1/EIP-191 signatures over the original VC and authorship bytes. */
const wallet=new Wallet('0x'+'11'.repeat(32)); // Public deterministic test key; not a service credential.
const signer:DelegationSigner=async payload=>({
  signature:await wallet.signMessage(payload),
  signerAddress:wallet.address,
  verificationMethod:('did:ethr:'+wallet.address) as IRI,
});
const verifier:DelegationVerifier=async(payload,proof)=>{
  try {
    const recovered=verifyMessage(payload,proof.proofValue);
    return recovered.toLowerCase()===proof.signerAddress.toLowerCase()&&
      proof.verificationMethod.toLowerCase()===('did:ethr:'+recovered).toLowerCase();
  } catch{return false;}
};
const pod='https://gate.example.test/owner/' as IRI;
const owner='https://identity.example.test/users/owner/profile#me' as IRI;
const descriptorUrl=pod+'context-graphs/legacy-alias.ttl';
const legacy:AuthorizedAgentData={
  agentId:slug as IRI,delegatedBy:owner,scope:'ReadWrite',validFrom:'2020-01-01T00:00:00Z',
};
let profile=createOwnerProfile(owner,'Fixture owner',[legacy]);
const legacyCredential=await createSignedDelegationCredential(profile,legacy,pod,signer);
const originalCredentialBytes=delegationCredentialToJsonLd(legacyCredential);
const documents=new Map<string,string>([[pod+'credentials/'+encodeURIComponent(slug)+'.jsonld',originalCredentialBytes]]);
const requests:string[]=[];
const fixtureFetch:FetchFn=async(url,init)=>{
  assert.equal(init?.method??'GET','GET','verification never writes or changes a grant');
  requests.push(url);
  const body=url===pod+'agents'?ownerProfileToTurtle(profile):documents.get(url);
  return new Response(body??'',{status:body===undefined?404:200,
    headers:{'Content-Type':url.endsWith('.jsonld')?'application/ld+json':'text/turtle'}});
};
const checkPrincipal=(principal:string)=>verifyPrincipalDelegation(principal as IRI,pod,{
  identityBaseUrl:ID,fetch:fixtureFetch,verifier,
});
const legacyChain=await checkPrincipal(did);
assert.equal(legacyChain.valid,true);
assert.equal(legacyChain.trustLevel,'CryptographicallyVerified');
assert.equal(legacyChain.scope,'ReadWrite');
assert.equal(legacyChain.delegationSubject.registered,slug);
assert.ok(requests.includes(pod+'credentials/'+encodeURIComponent(slug)+'.jsonld'),
  'the verifier fetches the original credential, rather than inventing a canonical-DID credential');
assert.equal(documents.get(pod+'credentials/'+encodeURIComponent(slug)+'.jsonld'),originalCredentialBytes,
  'verification leaves the genuinely signed legacy VC bytes untouched');

const graphBody='<urn:graph:alias-regression> <http://purl.org/dc/terms/title> "Bound content" .';
const digest=canonicalGraphDigest(graphBody);
assert.ok(digest);
const proof=await createSignedAuthorship({
  agentId:did as IRI,agentDid:did as IRI,ownerWebId:owner,
  descriptorId:descriptorUrl as IRI,created:new Date().toISOString(),contentHash:digest,
},signer);
const receivedProof=parseAuthorshipProofFromDescriptorTurtle(buildAuthorshipProofBlock(proof));
assert.ok(receivedProof);
assert.equal(receivedProof.issuer,did,'descriptor attribution remains the signed canonical DID');
const signature=await verifySignedAuthorship(receivedProof,verifier,{contentHash:digest});
assert.equal(signature.valid,true);
assert.equal(signature.contentBinding,'bound');
const descriptorBinding=proofBindsToDescriptorUrl(receivedProof.descriptorId,descriptorUrl,undefined,{
  claimedOwner:receivedProof.ownerWebId,servingPodOwner:owner,
});
assert.equal(authorshipVerdict({signatureValid:signature.valid,descriptorBinding}).verified,true);
const readbackChain=await checkPrincipal(receivedProof.issuer);
assert.equal(readbackChain.trustLevel,'CryptographicallyVerified',
  'a genuinely signed canonical authorship proof reaches the original bare VC on readback');
assert.equal((await verifySignedAuthorship({...receivedProof,issuer:slug as IRI},verifier,{contentHash:digest})).valid,false,
  'rewriting the issuer invalidates the genuine signature; alias resolution never rewrites it');
assert.equal((await verifySignedAuthorship(receivedProof,verifier,{contentHash:canonicalGraphDigest(
  '<urn:graph:alias-regression> <http://purl.org/dc/terms/title> "Different content" .',
)!})).valid,false,'a real content swap still fails verification');

const canonical:AuthorizedAgentData={...legacy,agentId:did as IRI,scope:'ReadOnly'};
profile=createOwnerProfile(owner,'Fixture owner',[legacy,canonical]);
const canonicalCredential=await createSignedDelegationCredential(profile,canonical,pod,signer);
documents.set(pod+'credentials/'+encodeURIComponent(did)+'.jsonld',delegationCredentialToJsonLd(canonicalCredential));
const narrowed=await checkPrincipal(did);
assert.equal(narrowed.scope,'ReadOnly','a narrower exact canonical grant beats the ReadWrite alias');
assert.equal(narrowed.delegationSubject.registered,did);
profile=createOwnerProfile(owner,'Fixture owner',[legacy,{...canonical,validUntil:'2020-01-02T00:00:00Z'}]);
assert.equal((await checkPrincipal(did)).valid,false,'an expired canonical row cannot fall through to the live alias');

profile=createOwnerProfile(owner,'Fixture owner',[legacy,canonical]);
const revokedSubjects=equivalentDelegationSubjects(did,profile.authorizedAgents,ID);
assert.ok(revokedSubjects.includes(slug)&&revokedSubjects.includes(did));
for(const target of revokedSubjects)profile=removeAuthorizedAgent(profile,target as IRI);
assert.equal((await checkPrincipal(did)).valid,false,
  'owner revocation survives actual Turtle serialization, which drops all revoked rows');
assert.equal((await verifySignedAuthorship(receivedProof,verifier,{contentHash:digest})).valid,true,
  'revocation changes current delegation trust, not the validity of the historical signature');
assert.equal(documents.get(pod+'credentials/'+encodeURIComponent(slug)+'.jsonld'),originalCredentialBytes);

profile=createOwnerProfile(owner,'Fixture owner',[legacy]);
const bareOwnerTargets=equivalentDelegationSubjects(did,profile.authorizedAgents,ID);
for(const target of bareOwnerTargets)profile=removeAuthorizedAgent(profile,target as IRI);
assert.equal((await checkPrincipal(did)).valid,false,
  'an owner revoking the canonical principal also revokes its only legacy registration');
profile=createOwnerProfile(owner,'Fixture owner',[legacy]);
assert.equal((await checkPrincipal('did:web:attacker.test:agents:'+slug)).valid,false,
  'a foreign authority cannot use an identical suffix to acquire the signed grant');
assert.deepEqual(equivalentDelegationSubjects('did:web:attacker.test:agents:'+slug,profile.authorizedAgents,ID),
  ['did:web:attacker.test:agents:'+slug]);

const tamperedCredential={...legacyCredential,credentialSubject:{...legacyCredential.credentialSubject,id:did as IRI}};
documents.set(pod+'credentials/'+encodeURIComponent(slug)+'.jsonld',delegationCredentialToJsonLd(tamperedCredential));
assert.equal((await checkPrincipal(did)).valid,false,'changing the original credential subject invalidates its ECDSA proof');
documents.set(pod+'credentials/'+encodeURIComponent(slug)+'.jsonld',originalCredentialBytes);
assert.equal((await checkPrincipal(did)).valid,true);
process.stdout.write('Genuine-signature alias publication/readback and owner-revocation checks passed\n');
