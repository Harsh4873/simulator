import type {RateCard,Slate} from './types.ts';
import {validateGeneration} from './validate-card.ts';
import type {GenerationManifest,RefreshHealth} from './generation.ts';
export async function loadGeneration(get:(name:string)=>Promise<string|null>,digest:(text:string)=>Promise<string>):Promise<{slate:Slate;card:RateCard;health:RefreshHealth|null}>{
  let error:unknown;
  for(let attempt=0;attempt<3;attempt++)try{
    const [s,c,m,h]=await Promise.all(['slate.json','rate-card.json','manifest.json','health.json'].map(get));
    if(!s||!c)throw new Error('Missing data files');
    const slate=JSON.parse(s) as Slate,card=JSON.parse(c) as RateCard;
    validateGeneration(slate,card);
    if(m){
      const manifest=JSON.parse(m) as GenerationManifest;
      if(manifest.schema_version!==1||manifest.generated_at!==card.generated_at||manifest.input_hash!==card.input_hash||manifest.model_hash!==card.model_hash||manifest.slate_hash!==await digest(s)||manifest.card_hash!==await digest(c))throw new Error('Incoherent generation manifest');
    }else if(card.model_hash)throw new Error('Generation manifest unavailable');
    return {slate,card,health:h?JSON.parse(h):null};
  }catch(e){error=e;}
  throw error;
}
