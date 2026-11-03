import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadGeneration } from '../../src/load-generation.ts';
import { freshnessIssue } from '../../src/validate-card.ts';
import { renderSlate } from '../../src/slate.ts';
import { validateArtifact } from '../../scripts/validate-artifact.mjs';
import { validatePublicText } from '../../scripts/validate-privacy.mjs';

export async function checkGeneration(publicRoot: string) {
  validateArtifact(publicRoot);
  const loaded=await loadGeneration(async name=>{
    if(name==='health.json')return null;
    const text=readFileSync(join(publicRoot,'data',name),'utf8');
    validatePublicText(text,name);
    return text;
  },async text=>createHash('sha256').update(text).digest('hex'));
  const {slate,card}=loaded,now=new Date(card.generated_at!);
  assert.equal(freshnessIssue(slate,card,now),null);
  const html=renderSlate(slate,card,now);
  assert.ok(!html.includes('role="alert"'));
  if(slate.games.length===0){
    assert.match(html,new RegExp(`No NBA games on ${slate.date}`));
    assert.ok(!html.includes('data-event='));
  }
  return loaded;
}
