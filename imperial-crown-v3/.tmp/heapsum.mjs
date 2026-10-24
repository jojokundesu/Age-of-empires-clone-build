import { readFileSync, readdirSync } from 'node:fs';
const f = readdirSync('.').find(n => n.endsWith('.heapprofile'));
const p = JSON.parse(readFileSync(f, 'utf8'));
const agg = new Map();
const walk = (n, stack) => {
  const name = n.callFrame.functionName || '(anon)';
  const key = stack.slice(-3).concat(name).join(' > ');
  if (n.selfSize) agg.set(key, (agg.get(key)||0) + n.selfSize);
  for (const c of n.children || []) walk(c, stack.concat(name));
};
walk(p.head, []);
const rows = [...agg].sort((a,b)=>b[1]-a[1]).slice(0, 22);
const total = [...agg.values()].reduce((a,b)=>a+b,0);
console.log('total sampled bytes', (total/1048576).toFixed(1), 'MB');
for (const [k,v] of rows) console.log((v/1048576).toFixed(1).padStart(7), 'MB ', k);
