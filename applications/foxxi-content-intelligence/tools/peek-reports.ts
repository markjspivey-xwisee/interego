import { ethers } from 'ethers';
const BRIDGE='https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const SEED='foxxi-demo-acme-training-2026-05-17-v1';
const ADMIN_WEB='https://interego-acme-id.livelysky-8b81abb0.eastus.azurecontainerapps.io/users/admin/profile/card#me';
const enc=new TextEncoder();
const w=new ethers.Wallet(ethers.hexlify(ethers.getBytes(ethers.sha256(enc.encode(`${SEED}:u-admin`)))));
const now=new Date();
const body={sub:ADMIN_WEB,iat:now.toISOString(),exp:new Date(now.getTime()+3600000).toISOString(),nonce:ethers.sha256(enc.encode(`u-admin:${now.getTime()}:${Math.random()}`)).slice(2,18),address:w.address};
const sig=await w.signMessage(`Foxxi session\n  sub: ${body.sub}\n  iat: ${body.iat}\n  exp: ${body.exp}\n  nonce: ${body.nonce}`);
const token=Buffer.from(JSON.stringify({...body,sig}),'utf8').toString('base64url');
const H={Authorization:`Bearer ${token}`};
for(const t of ['', 'lens:maintainer', 'lens:johnny']){
  const q=t?`?tenant=${encodeURIComponent(t)}`:'';
  const a:any=await fetch(`${BRIDGE}/xapi/admin/aggregates${q}`,{headers:H}).then(r=>r.json());
  console.log(`\n== tenant '${t||'default'}' ==  total=${a.total} success=${a.successRate}`);
  console.log('  verbs:', (a.topVerbs??[]).map((v:any)=>`${v.display ?? v.id?.split(/[#/]/).pop()}:${v.count}`).join(', ') || '—');
  console.log('  actorKind:', JSON.stringify(a.byActorKind), ' contextKind:', JSON.stringify(a.byContextKind));
}
