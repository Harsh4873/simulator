import type {RateCard,Slate} from './types.ts';
import {validateGeneration} from './validate-card.ts';
import type {GenerationManifest,RefreshHealth} from './generation.ts';

async function readHealth(get: (name: string) => Promise<string | null>): Promise<RefreshHealth | null> {
  try {
    const text = await get('health.json');
    const health = text && JSON.parse(text);
    return health && typeof health.checked_at === 'string' && typeof health.input_hash === 'string' && typeof health.model_hash === 'string'
      ? health : null;
  } catch {
    // The card's own generation time supplies the freshness check when health is unavailable.
    return null;
  }
}

export async function loadGeneration(get:(name:string)=>Promise<string|null>,digest:(text:string)=>Promise<string>):Promise<{slate:Slate;card:RateCard;health:RefreshHealth|null;slateHash:string|null}>{
  let error:unknown;
  for(let attempt=0;attempt<3;attempt++)try{
    const [s,c,m,health]=await Promise.all([get('slate.json'),get('rate-card.json'),get('manifest.json'),readHealth(get)]);
    if(!s||!c)throw new Error('Missing data files');
    const slate=JSON.parse(s) as Slate,card=JSON.parse(c) as RateCard;
    validateGeneration(slate,card);
    let slateHash: string | null = null;
    if(m){
      const manifest=JSON.parse(m) as GenerationManifest;
      if(manifest.schema_version!==1||manifest.generated_at!==card.generated_at||manifest.input_hash!==card.input_hash||manifest.model_hash!==card.model_hash||manifest.slate_hash!==await digest(s)||manifest.card_hash!==await digest(c))throw new Error('Incoherent generation manifest');
      slateHash = manifest.slate_hash;
    }else if(card.model_hash)throw new Error('Generation manifest unavailable');
    return {slate,card,health,slateHash};
  }catch(e){error=e;}
  throw error;
}
