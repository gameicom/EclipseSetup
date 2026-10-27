import { readFile } from 'node:fs/promises';
import { sharedConfig } from '../dist/shared-config.js';
import { validateConfiguration, parseSnapshot } from '../dist/shared.js';
try {
  const {url,key}=validateConfiguration(sharedConfig);
  await readFile(new URL('../dist/vendor/supabase.js',import.meta.url));
  if(process.argv.includes('--online')) {
    const headers={apikey:key,'Content-Type':'application/json'};
    if(key.split('.').length===3)headers.Authorization='Bearer '+key;
    const response=await fetch(url+'/rest/v1/rpc/eclipse_read_timers',{
      method:'POST',headers,body:'{}',signal:AbortSignal.timeout(15000)
    });
    if(!response.ok)throw new Error('공동 데이터베이스 확인 실패 (HTTP '+response.status+'). supabase/setup.sql 실행과 공개 키를 확인하세요.');
    const data=await response.json();
    parseSnapshot(data?.snapshot);
    console.log('Shared database read succeeded. Realtime must also be enabled for eclipse_timer_state.');
  }
  console.log('Public browser configuration is valid.');
} catch(error) {
  console.error(error.message);
  process.exitCode=1;
}
