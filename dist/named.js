import {kstISO,parseKST,MAX_INTERVAL} from './core.js';
export const NAMED_LEVELS=Object.freeze([71,72,73,74]);
export const MAX_NAMED_BOSSES=64;
export function defaultNamedSettings(now=Date.now()) {
 return {version:1,kind:'named',timezone:'Asia/Seoul',sound:false,
  bosses:NAMED_LEVELS.map(level=>({level,interval_seconds:1800,anchor_kst:kstISO(now)}))};
}
export function validateNamedSettings(value) {
 if(!value || value.version!==1 || value.kind!=='named' || !Array.isArray(value.bosses)
  || value.bosses.length<1 || value.bosses.length>MAX_NAMED_BOSSES)
  throw new Error('네임드 설정 파일이 필요합니다. 보스는 1~64개까지 등록할 수 있습니다.');
 if(value.timezone!==undefined && value.timezone!=='Asia/Seoul') throw new Error('한국시간으로 저장된 설정만 불러올 수 있습니다.');
 const seen=new Set();
 const bosses=value.bosses.map(boss=>{
  if(!Number.isInteger(boss?.level) || boss.level<1 || boss.level>999 || seen.has(boss.level))
   throw new Error('네임드 레벨은 중복 없이 1~999로 입력해 주세요.');
  seen.add(boss.level);
  if(!Number.isInteger(boss.interval_seconds) || boss.interval_seconds<1 || boss.interval_seconds>MAX_INTERVAL)
   throw new Error('리젠 간격은 1초 이상, 999시간 59분 59초 이하여야 합니다.');
  parseKST(boss.anchor_kst);
  return {level:boss.level,interval_seconds:boss.interval_seconds,anchor_kst:boss.anchor_kst};
 }).sort((a,b)=>a.level-b.level);
 return {version:1,kind:'named',timezone:'Asia/Seoul',sound:value.sound===true,bosses};
}
