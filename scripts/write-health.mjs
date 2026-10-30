import {readFileSync,writeFileSync} from 'node:fs';
const card=JSON.parse(readFileSync('dist/data/rate-card.json','utf8'));
const {CHECKED_AT:checked_at,INPUT_HASH:input_hash,MODEL_HASH:model_hash}=process.env;
if(checked_at){
  if(!Number.isFinite(Date.parse(checked_at))||Date.parse(checked_at)>Date.now()+300000||card.input_hash!==input_hash||card.model_hash!==model_hash)throw new Error('Health attestation does not match deployed inputs');
  writeFileSync('dist/data/health.json',JSON.stringify({checked_at,input_hash,model_hash}));
}
