import {readFile,writeFile,mkdir} from 'node:fs/promises';
const target=new URL('../dist/setup/',import.meta.url);
await mkdir(target,{recursive:true});
for(const [source,destination] of [['push.sql','push-schema.sql'],['push-cron.sql','push-schedule.sql']]) {
 await writeFile(new URL(destination,target),await readFile(new URL('../supabase/'+source,import.meta.url)));
}
const handler=await readFile(new URL('../supabase/functions/boss-push/handler.js',import.meta.url),'utf8');
const bundled="// @ts-nocheck\nimport webpush from 'npm:web-push@3.6.7';\n"+handler+
"\nDeno.serve(createPushHandler({env:name=>Deno.env.get(name),generateRequestDetails:(...args)=>webpush.generateRequestDetails(...args)}));\n";
await writeFile(new URL('push-function.txt',target),bundled);
console.log('Browser setup materials prepared without private keys.');
