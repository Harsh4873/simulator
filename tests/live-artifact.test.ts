import test from 'node:test';
import { checkGeneration } from './helpers/check-generation.ts';

test('the generated artifact loads coherently and renders populated or empty slates',async()=>{
  await checkGeneration('public');
});
