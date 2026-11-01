import { createServer } from 'node:http';
import { mkdir, chown, readFile } from 'node:fs/promises';
import { createEncryptedStore, createSecurity } from './security.mjs';
import { createHealthBridge } from './bridge.mjs';

const env=(name,fallback)=>process.env[name]?.trim()||fallback;
const publicUrl=env('HEALTH_PUBLIC_URL');
if(!publicUrl)throw new Error('HEALTH_PUBLIC_URL is required.');
if(!env('HEALTH_RECORD_KEY'))throw new Error('A persistent HEALTH_RECORD_KEY is required before starting.');
if(!env('HEALTH_STORE_URL')&&!env('HEALTH_DATA_DIRECTORY'))throw new Error('Configure durable encrypted storage before starting.');
// Railway mounts persistent volumes as root. Prepare only this configured data directory,
// then drop the process privileges before accepting any network request.
if(process.getuid?.()===0&&env('HEALTH_DATA_DIRECTORY')){
  await mkdir(env('HEALTH_DATA_DIRECTORY'),{recursive:true,mode:0o700});
  await chown(env('HEALTH_DATA_DIRECTORY'),1000,1000);
  process.setgid(1000);process.setuid(1000);
}
const relayUrl=env('INTEREGO_RELAY_URL','https://relay.interego.xwisee.com');
const storageBearer=env('HEALTH_STORE_BEARER');
const store=createEncryptedStore({keyHex:env('HEALTH_RECORD_KEY'),rootUrl:env('HEALTH_STORE_URL'),directory:env('HEALTH_DATA_DIRECTORY'),...(storageBearer?{authorization:'Bearer '+storageBearer}:{})});
const security=createSecurity({relayUrl,identityHost:env('INTEREGO_IDENTITY_HOST','identity.interego.xwisee.com'),targetOrigin:new URL(publicUrl).origin,trustedRelayAddresses:env('INTEREGO_TRUSTED_RELAY_ADDRESSES','').split(',').filter(Boolean),store});
const atlas=env('ATLAS_ADMIN_PRINCIPAL')?{adminPrincipal:env('ATLAS_ADMIN_PRINCIPAL'),atlasUrl:'https://mayya-health-atlas.goldenfleece.chatgpt.site/',expectedSubject:{name:env('ATLAS_EXPECTED_NAME'),birthDate:env('ATLAS_EXPECTED_BIRTH_DATE')},baseRecord:JSON.parse(await readFile(new URL('./atlas-base.json',import.meta.url),'utf8'))}:undefined;
const bridge=createHealthBridge({publicUrl,relayUrl,store,security,
  ...(atlas?{atlas}:{}),
  duke:{clientId:env('DUKE_CLIENT_ID'),clientSecret:env('DUKE_CLIENT_SECRET'),privateKeyPem:env('DUKE_PRIVATE_KEY_PEM')?.replace(/\\n/g,'\n'),keyId:env('DUKE_KEY_ID'),sandboxPrivateKeyPem:env('DUKE_SANDBOX_PRIVATE_KEY_PEM')?.replace(/\\n/g,'\n'),sandboxKeyId:env('DUKE_SANDBOX_KEY_ID')},
  oura:{clientId:env('OURA_CLIENT_ID'),clientSecret:env('OURA_CLIENT_SECRET')}});
const server=createServer((req,res)=>{req.setTimeout(20000);void bridge.handler(req,res);});
server.requestTimeout=30000;server.headersTimeout=15000;server.maxHeadersCount=50;
server.listen(Number(env('PORT','8080')),env('HOST','127.0.0.1'),()=>console.log('Interego health bridge is listening. Source connections require their separate authorizations.'));
