import { buildBuilding, buildUnit, buildProp, BUILDING_TYPES, UNIT_TYPES } from '../src/gfx/models.js';
const winding = (geo) => {
  const v = geo.v, idx = geo.i;
  let vol = 0, tris = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 16, b = idx[t + 1] * 16, c = idx[t + 2] * 16;
    const ax = v[a], ay = v[a + 1], az = v[a + 2];
    const bx = v[b], by = v[b + 1], bz = v[b + 2];
    const cx = v[c], cy = v[c + 1], cz = v[c + 2];
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    tris++;
  }
  return { vol: vol / 6, tris };
};
const report = (label, res) => {
  if (!res) return;
  const g = res.geo.finish();
  const w = winding(g);
  console.log(label.padEnd(22), 'tris', String(w.tris).padStart(5), 'vol', w.vol.toFixed(3), w.vol > 0 ? 'CCW-out' : 'CW-out');
};
for (const t of BUILDING_TYPES) report('B:' + t, buildBuilding(t));
for (const t of UNIT_TYPES) report('U:' + t, buildUnit(t));
for (const t of ['bush','rock','stump','reed','tuft','flower','pebble','log','ruin','crate','barrel','haystack','firewood','cart','well','fence','drying_rack','brazier','tree0','tree1','tree2','tree3','tree_lod','gold_mine','stone_mine','berry_bush','deer','boar','fish','relic']) report('P:' + t, buildProp(t));
