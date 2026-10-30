import {readdirSync,readFileSync} from 'node:fs';
import {join,relative} from 'node:path';
export function validateArtifact(root){
  function visit(dir){for(const e of readdirSync(dir,{withFileTypes:true})){
    const path=join(dir,e.name),rel=relative(root,path);
    if(e.isDirectory())visit(path);
    else if(!/^(index\.html|favicon\.svg|\.nojekyll|assets\/[\w.-]+\.(js|css)|data\/(slate|rate-card|manifest|health)\.json)$/.test(rel))throw new Error(`Unexpected public artifact: ${rel}`);
  }}
  visit(root);
  for(const f of ['data/slate.json','data/rate-card.json'])JSON.parse(readFileSync(join(root,f),'utf8'));
}
if(process.argv[1]?.endsWith('/validate-artifact.mjs'))validateArtifact('dist');
