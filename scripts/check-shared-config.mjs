import { readFile } from 'node:fs/promises';
import { sharedConfig } from '../dist/shared-config.js';
import { validateConfiguration, parseSnapshot } from '../dist/shared.js';
try {
  const {url,key}=validateConfiguration(sharedConfig);
  await readFile(new URL('../dist/vendor/supabase.js',import.meta.url));
  if(process.argv.includes('--online')) {
    const headers={apikey:key,'Content-Type':'application/json'};
    if(key.split('.').length===3)headers.Authorization='Bearer '+key;
    for(const [group,rpc,setup] of [['field','eclipse_read_timers','supabase/setup.sql'],['named','eclipse_read_named_timers','dist/setup/named-update.sql']]) {
      const response=await fetch(url+'/rest/v1/rpc/'+rpc,{
        method:'POST',headers,body:'{}',signal:AbortSignal.timeout(15000)
      });
      if(!response.ok)throw new Error((group==='named'?'네임드':'필보')+' 공동 데이터베이스 확인 실패 (HTTP '+response.status+'). '+setup+' 전체를 Supabase SQL Editor에서 실행하세요.');
      const data=await response.json();
      parseSnapshot(data?.snapshot,group);
      console.log(group+' shared database read succeeded.');
    }
    console.log('Realtime must be enabled for eclipse_timer_state and eclipse_named_timer_state.');
  }
  console.log('Public browser configuration is valid.');
} catch(error) {
  console.error(error.message);
  process.exitCode=1;
}
