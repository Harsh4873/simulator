import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
export function validatePublicText(text,path='input'){
  // Public contact data is unnecessary here; only the two approved commit identities are permitted.
  const allowed=new Set(['43502626+Harsh4873@users.noreply.github.com','41898282+github-actions[bot]@users.noreply.github.com']);
  for(const match of text.matchAll(/[A-Za-z0-9_.+\[\]-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g))if(!allowed.has(match[0]))throw new Error(`Unapproved email in ${path}`);
  if(/(?:owner[_ -]?(?:real[_ -]?name|home[_ -]?(?:address|location)|personal[_ -]?email))\s*[:=]\s*["']?[^\s"'}]+/i.test(text))throw new Error(`Personal owner metadata in ${path}`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const files=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{encoding:'utf8'}).split('\0').filter(Boolean);
  for(const path of files){if(/\.(?:png|jpg|gz|ico|woff2?)$/.test(path))continue;validatePublicText(readFileSync(path,'utf8'),path);}
}
