import {sharedConfig} from './shared-config.js';
import {generatePushKeys,buildPushSetup} from './push-setup-core.js';
const $=id=>document.getElementById(id),projectUrl='https://xywqclfppwsiiydlniba.supabase.co';
let keys=null,materials=null,prepared=null;
const status=message=>{$('setup-status').textContent=message;};
const headers={apikey:sharedConfig.supabasePublishableKey,'Content-Type':'application/json'};
if(sharedConfig.supabasePublishableKey.split('.').length===3)headers.Authorization='Bearer '+sharedConfig.supabasePublishableKey;
async function getInfo() {
 const response=await fetch(projectUrl+'/rest/v1/rpc/eclipse_push_info',{method:'POST',headers,body:'{}',signal:AbortSignal.timeout(12000)});
 const value=await response.json();
 if(response.status===404 && value.code==='PGRST202')return null;
 if(!response.ok)throw new Error('공동 서버 연결을 확인하지 못했습니다. 잠시 후 새로고침해 주세요.');
 return value;
}
async function copy(value) {
 try {await navigator.clipboard.writeText(value);status('복사했습니다. 안내된 Supabase 웹 화면에 붙여넣으세요.');}
 catch {status('클립보드에 복사하지 못했습니다. 브라우저의 클립보드 권한을 확인해 주세요.');}
}
$('generate-keys').addEventListener('click',async()=>{
 $('generate-keys').disabled=true;
 try {
  // Recheck immediately before creating keys so an existing installation is never rotated silently.
  const current=await getInfo();
  if(current?.public_key)throw new Error('이미 알림 키가 등록되어 있습니다. 기존 키를 유지하세요. 발송기 코드는 복사해 업데이트할 수 있습니다.');
  keys=await generatePushKeys();
  prepared=buildPushSetup(materials.schema,materials.cron,keys,projectUrl);
  $('setup-secrets').value=prepared.secrets;
  for(const id of ['copy-secrets','copy-sql','verify-push'])$(id).disabled=false;
  status('키를 준비했습니다. 1 → 2 → 3 순서로 Supabase에 등록한 뒤 연결을 확인하세요.');
 } catch(error){status(error.message);$('generate-keys').disabled=false;}
});
$('copy-secrets').addEventListener('click',()=>copy(prepared.secrets));
$('copy-function').addEventListener('click',()=>copy(materials.functionCode));
$('copy-update').addEventListener('click',()=>copy(materials.schema));
$('copy-sql').addEventListener('click',()=>copy(prepared.sql));
$('verify-push').addEventListener('click',async()=>{
 $('verify-push').disabled=true;
 try {
  const info=await getInfo();
  if(!info?.enabled || info.public_key!==keys.publicKey)throw new Error('예약 설정이 아직 확인되지 않습니다. 3단계 SQL 실행 결과를 확인해 주세요.');
  const response=await fetch(projectUrl+'/functions/v1/boss-push',{method:'POST',
   headers:{Authorization:'Bearer '+keys.dispatchSecret,'Content-Type':'application/json'},
   body:JSON.stringify({health:true}),signal:AbortSignal.timeout(20000)});
  if(!response.ok || !(await response.json()).ready)throw new Error('발송기 연결 실패: 1단계 Secrets와 2단계 함수 이름·JWT 설정을 확인해 주세요.');
  status('푸시 서버 연결을 확인했습니다. 타이머로 돌아가 새로고침 후 기기에서 푸시를 켜 주세요.');
 } catch(error){status(error.message);}
 finally {$('verify-push').disabled=false;}
});
try {
 if(sharedConfig.supabaseUrl!==projectUrl)throw new Error('프로젝트 주소가 일치하지 않습니다.');
 const names=['push-schema.sql','push-schedule.sql','push-function.txt'];
 const content=await Promise.all(names.map(async name=>{
  const response=await fetch('./setup/'+name,{cache:'no-store'});
  if(!response.ok)throw new Error('설정 자료를 불러오지 못했습니다.');
  return response.text();
 }));
 materials={schema:content[0],cron:content[1],functionCode:content[2]};
 $('copy-function').disabled=false;
 const info=await getInfo();
 if(info?.public_key) {
  $('server-update').hidden=false;
  $('copy-update').disabled=false;
  status(info.enabled?'푸시 서버가 설정되어 있습니다. 기능 변경을 적용하려면 아래 업데이트 SQL을 실행한 뒤 타이머를 새로고침하세요.':'기존 알림 키가 있습니다. Supabase의 발송기와 Cron 상태를 확인하세요. 키를 다시 만들지는 않습니다.');
 } else {
  $('generate-keys').disabled=false;status('최초 설정이 필요합니다. 아래 1단계부터 진행하세요. 별도 프로그램 설치는 필요하지 않습니다.');
 }
} catch(error){status(error.message);}
