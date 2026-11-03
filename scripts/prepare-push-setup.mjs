import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {combinePushSQL} from '../dist/push-setup-core.js';
const target=new URL('../dist/setup/',import.meta.url);
await mkdir(target,{recursive:true});
for(const [source,destination] of [['named.sql','named-update.sql'],['push.sql','push-schema.sql'],['push-cron.sql','push-schedule.sql'],['push-scheduler.sql','push-scheduler.sql']]) {
 await writeFile(new URL(destination,target),await readFile(new URL('../supabase/'+source,import.meta.url)));
}
await writeFile(new URL('push-update.sql',target),combinePushSQL(
 await readFile(new URL('../supabase/push.sql',import.meta.url),'utf8'),
 await readFile(new URL('../supabase/push-scheduler.sql',import.meta.url),'utf8')));
const handler=await readFile(new URL('../supabase/functions/boss-push/handler.js',import.meta.url),'utf8');
const bundled="// @ts-nocheck\nimport webpush from 'npm:web-push@3.6.7';\n"+handler+
"\nDeno.serve(createPushHandler({env:name=>Deno.env.get(name),generateRequestDetails:(...args)=>webpush.generateRequestDetails(...args)}));\n";
await writeFile(new URL('push-function.txt',target),bundled);
console.log('Browser setup materials prepared without private keys.');
