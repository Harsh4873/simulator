export type Rng = () => number;

export const POISSON_MEAN_CAP = 80;

export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function iterationSeed(base: number, index: number): number {
  let z = (base + Math.imul(index, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}

export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normal(rng: Rng): number {
  let u = rng();
  while (u <= 0) u = rng();
  let v = rng();
  while (v <= 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function gamma(shape: number, rng: Rng): number {
  if (!Number.isFinite(shape) || !(shape > 0)) throw new Error('gamma shape must be positive');
  if (shape < 1) {
    const u = rng();
    return gamma(shape + 1, rng) * u ** (1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let attempt = 0; attempt < 10000; attempt += 1) {
    const x = normal(rng);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  throw new Error('gamma draw did not converge');
}

export function gammaMean1(shape: number, rng: Rng): number {
  return gamma(shape,rng)/shape;
}

export function poisson(mean: number, rng: Rng): number {
  if(!Number.isFinite(mean)||mean<0)throw new Error('Poisson mean must be finite and nonnegative');
  // Poisson additivity avoids underflow without silently truncating large means.
  let count=0,remaining=mean;
  while(remaining>0){
    const part=Math.min(remaining,POISSON_MEAN_CAP),limit=Math.exp(-part);
    let product=1,k=0;
    do {k++;product*=rng();}while(product>limit);
    count+=k-1;remaining-=part;
  }
  return count;
}

export function binomial(n: number, p: number, rng: Rng): number {
  if (n <= 0 || p <= 0) return 0;
  const trials = Math.floor(n);
  if (p >= 1) return trials;
  let made = 0;
  for (let i = 0; i < trials; i += 1) {
    if (rng() < p) made += 1;
  }
  return made;
}
