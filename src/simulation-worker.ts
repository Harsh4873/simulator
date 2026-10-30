import { simulate } from './simulate.ts';
import type { RateGame } from './types.ts';
self.onmessage=(event: MessageEvent<{game:RateGame;seed:number;iterations:number}>)=>{
  try {self.postMessage({result:simulate(event.data.game,event.data.seed,event.data.iterations,completed=>self.postMessage({progress:completed/event.data.iterations}))});}
  catch(e){self.postMessage({error:e instanceof Error?e.message:'Simulation failed'});}
};
