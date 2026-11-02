export function toBase64Url(bytes) {
 return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
export async function generatePushKeys(cryptoApi=crypto) {
 const pair=await cryptoApi.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const jwk=await cryptoApi.subtle.exportKey('jwk',pair.privateKey);
 const decode=text=>Uint8Array.from(atob(text.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
 return {publicKey:toBase64Url(new Uint8Array([4,...decode(jwk.x),...decode(jwk.y)])),
 privateKey:jwk.d,dispatchSecret:toBase64Url(cryptoApi.getRandomValues(new Uint8Array(32)))};
}
export function combinePushSQL(...parts) {
 return 'begin;\n'+parts.map(part=>part.replace(/^begin;\r?$/gm,'').replace(/^commit;\r?$/gm,'')).join('\n')+'\ncommit;\n';
}
export function buildPushSetup(schema,cron,keys,projectUrl,scheduler='') {
 if(!/^https:\/\/[a-z]{20}\.supabase\.co$/.test(projectUrl) ||
 !/^[A-Za-z0-9_-]{87}$/.test(keys.publicKey) ||
 !/^[A-Za-z0-9_-]{43}$/.test(keys.privateKey) ||
 !/^[A-Za-z0-9_-]{43}$/.test(keys.dispatchSecret)) throw new Error('Invalid push setup values');
 return {
 secrets:'ECLIPSE_VAPID_PUBLIC_KEY='+keys.publicKey+'\nECLIPSE_VAPID_PRIVATE_KEY='+keys.privateKey+'\nECLIPSE_PUSH_SECRET='+keys.dispatchSecret,
  sql:combinePushSQL(schema,"update public.eclipse_push_config set public_key='"+keys.publicKey+"' where id=1;",
   cron.replaceAll('__PUSH_SECRET__',keys.dispatchSecret).replaceAll('__FUNCTION_URL__',projectUrl+'/functions/v1/boss-push'),scheduler)
 };
}
