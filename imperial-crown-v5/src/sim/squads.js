/* ============================================================
   squads.js — a small, persistent company with a shared history

   Personal veterancy still belongs to the individual. A squad earns
   a second, shared pool from those same deeds, normalised by the
   square root of its size. Casualties leave the survivors' history
   intact. A late recruit starts at the current pool, and must earn
   their own bond instead of inheriting an instant elite promotion.

   The only proximity work is a bounded pair check twice a second,
   and nothing is scanned at all in a match without squads.
   ============================================================ */
export const SQUAD_RANKS = [
  { name: 'Formed', xp: 0, perk: 'Earn experience together.' },
  { name: 'Drilled', xp: 60, perk: '+5% movement speed.' },
  { name: 'Battlebound', xp: 150, perk: '+1 melee and pierce armour near a squadmate.' },
  { name: 'Elite', xp: 300, perk: '+10% attack near a squadmate.' }
];
export const MAX_SQUAD_SIZE = 24;
export const MAX_SQUADS = 12;
export const SQUAD_COHESION_RANGE = 12;

export function squadRank(xp) {
  let rank = 0;
  while (rank + 1 < SQUAD_RANKS.length && xp >= SQUAD_RANKS[rank + 1].xp) rank++;
  return rank;
}

export class Squads {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.nextId = 1;
    this.acc = 0;
    this.revision = 0;
  }

  eligible(u) {
    return !!u && u.kind === 'unit' && !u.dead && u.team === this.game.playerTeam;
  }

  create(units, name = '') {
    const members = [...new Set(units || [])].filter((u) => this.eligible(u) && !u.squad);
    if (this.list.length >= MAX_SQUADS) return { ok: false, reason: `Maximum ${MAX_SQUADS} squads` };
    if (members.length < 2) return { ok: false, reason: 'Select at least two unassigned friendly units' };
    if (members.length > MAX_SQUAD_SIZE) return { ok: false, reason: `A squad holds at most ${MAX_SQUAD_SIZE} units` };
    const id = this.nextId++;
    const clean = String(name || '').trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 24);
    const squad = { id, name: clean || `Squad ${id}`, xp: 0, members: [] };
    this.list.push(squad);
    for (const u of members) this._join(squad, u, 0);
    this.revision++;
    return { ok: true, squad };
  }

  _join(squad, u, joinedAt) {
    u.squad = squad;
    u.squadJoinedAt = joinedAt;
    u.squadCohesive = false;
    squad.members.push(u);
  }

  add(squad, units) {
    if (!this.list.includes(squad)) return { ok: false, reason: 'Squad no longer exists' };
    const members = [...new Set(units || [])].filter((u) => this.eligible(u) && !u.squad);
    if (!members.length) return { ok: false, reason: 'Select unassigned friendly units first' };
    if (squad.members.length + members.length > MAX_SQUAD_SIZE) return { ok: false, reason: `A squad holds at most ${MAX_SQUAD_SIZE} units` };
    for (const u of members) this._join(squad, u, squad.xp);
    this.revision++;
    return { ok: true, count: members.length };
  }

  remove(u) {
    const squad = u && u.squad;
    if (!squad) return false;
    const i = squad.members.indexOf(u);
    if (i >= 0) squad.members.splice(i, 1);
    u.squad = null;
    u.squadJoinedAt = 0;
    u.squadCohesive = false;
    this.revision++;
    if (!squad.members.length) {
      const index = this.list.indexOf(squad);
      if (index >= 0) this.list.splice(index, 1);
    }
    return true;
  }

  disband(squad) {
    if (!this.list.includes(squad)) return false;
    for (const u of squad.members.slice()) this.remove(u);
    return true;
  }

  rank(squad) { return squadRank(squad?.xp || 0); }
  memberRank(u) {
    if (!u || !u.squad) return 0;
    return squadRank(Math.max(0, u.squad.xp - (u.squadJoinedAt || 0)));
  }

  gain(u, amount) {
    const squad = u && u.squad;
    if (!squad || !this.eligible(u) || !Number.isFinite(amount) || amount <= 0) return;
    const before = this.rank(squad);
    squad.xp = Math.min(100000, squad.xp + amount / Math.sqrt(Math.max(1, squad.members.length)));
    const after = this.rank(squad);
    if (after > before) {
      this.revision++;
      this.game.notify?.(`${squad.name} is now ${SQUAD_RANKS[after].name}`, 'good');
      this.game.sound?.play?.('horn');
    }
  }

  speedMul(u) { return this.memberRank(u) >= 1 ? 1.05 : 1; }
  armorBonus(u) { return u.squadCohesive && this.memberRank(u) >= 2 ? 1 : 0; }
  attackMul(u) { return u.squadCohesive && this.memberRank(u) >= 3 ? 1.10 : 1; }

  update(dt) {
    if (!this.list.length) return;
    this.acc += dt;
    if (this.acc < 0.5) return;
    this.acc = 0;
    const r2 = SQUAD_COHESION_RANGE * SQUAD_COHESION_RANGE;
    for (let si = this.list.length - 1; si >= 0; si--) {
      const squad = this.list[si];
      const m = squad.members;
      for (let i = m.length - 1; i >= 0; i--) {
        if (!this.eligible(m[i])) this.remove(m[i]);
      }
      for (let i = 0; i < m.length; i++) m[i].squadCohesive = false;
      for (let i = 0; i < m.length; i++) {
        const a = m[i];
        if (a.garrisoned) continue;
        for (let j = i + 1; j < m.length; j++) {
          const b = m[j];
          if (b.garrisoned) continue;
          const dx = a.x - b.x, dz = a.z - b.z;
          if (dx * dx + dz * dz <= r2) { a.squadCohesive = true; b.squadCohesive = true; }
        }
      }
    }
  }

  /** Indices refer to the same live unit array that the save serialises. */
  toJSON(unitIndex) {
    return {
      nextId: this.nextId,
      squads: this.list.map((s) => ({ id: s.id, name: s.name, xp: s.xp,
        members: s.members.filter((u) => unitIndex.has(u)).map((u) => [unitIndex.get(u), u.squadJoinedAt || 0]) }))
    };
  }

  fromJSON(data, units) {
    if (!data || !Array.isArray(data.squads)) return;
    for (const record of data.squads.slice(0, MAX_SQUADS)) {
      const xp = Number.isFinite(record.xp) ? Math.max(0, Math.min(100000, record.xp)) : 0;
      const id = Number.isInteger(record.id) && record.id > 0 ? record.id : this.nextId;
      const squad = { id, name: String(record.name || `Squad ${id}`).slice(0, 24), xp, members: [] };
      for (const item of (record.members || []).slice(0, MAX_SQUAD_SIZE)) {
        const u = units[item[0]];
        if (this.eligible(u) && !u.squad) this._join(squad, u, Math.max(0, Math.min(xp, Number(item[1]) || 0)));
      }
      if (squad.members.length) this.list.push(squad);
      this.nextId = Math.max(this.nextId, id + 1);
    }
    if (Number.isInteger(data.nextId)) this.nextId = Math.max(this.nextId, data.nextId);
    this.revision++;
    this.update(0.5);
  }
}
