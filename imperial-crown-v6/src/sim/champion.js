/* ============================================================
   champion.js — the unit you personally command
   ------------------------------------------------------------
   Version 5 let you stand inside a soldier and swing his sword. It
   did not let him become anyone. This module is the missing half: a
   single, persistent *person* who grows because you are the one
   holding the weapon.

   A Champion is not a new kind of unit and it is not a second
   simulation. It is the same Unit object the RTS already moves,
   costs, feeds and can kill, plus a record on it:

       unit.champion = { renown, rank, picks, stamina, cooldowns … }

   Renown is earned by *deeds*, and the numbers here are deliberately
   the deeds the player already performs in first person: damage put
   in, blows taken and survived, kills, parries, spells cast, wood
   gathered, foundations raised. Every rank-up offers a choice of
   three permanent perks, and the perks are wired into the same
   functions everything else goes through — stats(), takeDamage(),
   performAttack(), gatherRate(), addBuilder() — so a Champion in the
   strategy view keeps every bonus he earned in first person.

   The promise this file has to keep: *no perk may be cosmetic*. If a
   perk says "+18% attack", the number in stats() is 18% higher and
   the damage that lands on the enemy is 18% higher, whether you are
   watching from the sky or from behind his eyes.
   ============================================================ */
import { clamp } from '../core/math.js';

/* ------------------------------------------------------------------
   ranks
   ------------------------------------------------------------------ */
export const CHAMPION_RANKS = [
  { rank: 1, name: 'Sworn', xp: 0, blurb: 'You took the field in person.' },
  { rank: 2, name: 'Banneret', xp: 110, blurb: 'The men have started to watch you.' },
  { rank: 3, name: 'Captain', xp: 300, blurb: 'Your name is passed down the line.' },
  { rank: 4, name: 'Warden', xp: 620, blurb: 'The enemy asks where you are standing.' },
  { rank: 5, name: 'Marshal', xp: 1050, blurb: 'A battle turns around your position.' },
  { rank: 6, name: 'Legend', xp: 1650, blurb: 'They will tell this one for a hundred years.' }
];
export const MAX_CHAMPION_RANK = CHAMPION_RANKS.length - 1;   // index of the last

/** The rank *index* (0..5) a renown total has earned. */
export function rankIndexFor(renown) {
  let r = 0;
  while (r + 1 < CHAMPION_RANKS.length && renown >= CHAMPION_RANKS[r + 1].xp) r++;
  return r;
}

/** Renown still needed for the next rank, and how far along we are. */
export function rankProgress(unit) {
  const st = unit && unit.champion;
  if (!st) return { rank: 0, next: CHAMPION_RANKS[1].xp, frac: 0, max: false };
  const r = rankIndexFor(st.renown);
  if (r >= MAX_CHAMPION_RANK) return { rank: r, next: null, frac: 1, max: true };
  const lo = CHAMPION_RANKS[r].xp, hi = CHAMPION_RANKS[r + 1].xp;
  return { rank: r, next: hi, frac: clamp((st.renown - lo) / Math.max(1, hi - lo), 0, 1), max: false };
}

/* ------------------------------------------------------------------
   perks
   ----------------------------------------------------------------
   `apply(m, unit)` folds the perk into the modifier bag `m`. Nothing
   here touches the world directly; the bag is read by the systems that
   already run every tick, so a perk cannot double-apply by being
   applied in two places.
   ------------------------------------------------------------------ */
const MELEE = (u) => !!(u.def && !u.def.siege && !(u.def.range > 1.4) && (u.def.attack || 0) > 0);
const RANGED = (u) => !!(u.def && (u.def.range || 0) > 5 && (u.def.attack || 0) > 0);
const FIGHTER = (u) => !!(u.def && (u.def.attack || 0) > 0 && !(u.def.classes || []).includes('monk'));
const VILLAGER = (u) => !!u && u.type === 'villager';
const CASTER = (u) => !!(u.def && u.def.caster);
const MONK = (u) => !!(u.def && (u.def.classes || []).includes('monk'));

export const PERKS = [
  /* ---- arms: how the weapon lands ---------------------------------- */
  { id: 'keen_edge', name: 'Keen Edge', icon: 'sword', cat: 'arms', needs: FIGHTER,
    desc: '+18% attack.', apply: (m) => { m.attackMul *= 1.18; } },
  { id: 'cleave', name: 'Cleave', icon: 'axe', cat: 'arms', needs: MELEE,
    desc: 'Melee blows splash 45% of their damage to other enemies within 2.6 m.',
    apply: (m) => { m.cleave = Math.max(m.cleave, 0.45); } },
  { id: 'deadeye', name: 'Deadeye', icon: 'bow', cat: 'arms', needs: RANGED,
    desc: '+25% damage against targets further than 8 m.',
    apply: (m) => { m.longShot = 1.25; } },
  { id: 'quick_hands', name: 'Quick Hands', icon: 'hourglass', cat: 'arms', needs: FIGHTER,
    desc: '18% faster attacks.', apply: (m) => { m.attackSpeedMul *= 0.82; } },
  { id: 'piercer', name: 'Armour Piercer', icon: 'spear', cat: 'arms', needs: FIGHTER,
    desc: '+3 damage that armour does not stop.', apply: (m) => { m.pierce += 3; } },
  { id: 'executioner', name: 'Executioner', icon: 'skull', cat: 'arms', needs: FIGHTER,
    desc: '+45% damage to enemies below 35% health.',
    apply: (m) => { m.executioner = 1.45; } },
  { id: 'riposte', name: 'Riposte', icon: 'shield', cat: 'arms', needs: MELEE,
    desc: 'Melee attackers take 30% of the damage they deal to you.',
    apply: (m) => { m.riposte = 0.30; } },

  /* ---- ward: how the body holds ------------------------------------ */
  { id: 'iron_skin', name: 'Iron Skin', icon: 'shield', cat: 'ward', needs: () => true,
    desc: '+2 melee and +2 pierce armour.', apply: (m) => { m.armor += 2; m.pierceArmor += 2; } },
  { id: 'stalwart', name: 'Stalwart', icon: 'wall', cat: 'ward', needs: () => true,
    desc: 'All damage taken is reduced by 12%.', apply: (m) => { m.damageTakenMul *= 0.88; } },
  { id: 'second_wind', name: 'Second Wind', icon: 'heart', cat: 'ward', needs: () => true,
    desc: 'Dropping below 28% health heals 22% of your pool (once per 45 s).',
    apply: (m) => { m.secondWind = 1; } },
  { id: 'undying', name: 'Undying', icon: 'crown', cat: 'ward', needs: () => true,
    desc: 'A killing blow leaves you at 1 health instead (once per 120 s).',
    apply: (m) => { m.undying = 1; } },
  { id: 'shielded', name: 'Shield Bearer', icon: 'shield', cat: 'ward', needs: (u) => MELEE(u) || true,
    desc: 'Blocking stops 78% of frontal damage instead of 62%, and costs less stamina.',
    apply: (m) => { m.blockMul = 0.22; m.blockDrainMul *= 0.75; } },

  /* ---- stride: how the body moves ---------------------------------- */
  { id: 'fleet', name: 'Fleet Foot', icon: 'boot', cat: 'stride', needs: () => true,
    desc: '+14% movement speed.', apply: (m) => { m.speedMul *= 1.14; } },
  { id: 'sprinter', name: 'Long Stride', icon: 'boot', cat: 'stride', needs: () => true,
    desc: 'Sprint is 20% faster and costs 35% less stamina.',
    apply: (m) => { m.sprintMul *= 1.2; m.staminaDrainMul *= 0.65; } },
  { id: 'dodge_master', name: 'Roll with It', icon: 'bolt', cat: 'stride', needs: () => true,
    desc: 'Dodge recharges 40% faster and its invulnerability lasts 0.15 s longer.',
    apply: (m) => { m.dodgeCdMul *= 0.6; m.dodgeInvuln += 0.15; } },
  { id: 'surefoot', name: 'Surefoot', icon: 'mountain', cat: 'stride', needs: () => true,
    desc: 'Rough ground no longer slows you.', apply: (m) => { m.surefoot = true; } },

  /* ---- banner: what the men do around you --------------------------- */
  { id: 'banner', name: 'War Banner', icon: 'flag', cat: 'banner', needs: () => true,
    desc: 'Allies within 12 m gain +12% attack.', apply: (m) => { m.bannerAttack = 1.12; } },
  { id: 'aegis', name: 'Aegis', icon: 'shield', cat: 'banner', needs: () => true,
    desc: 'Allies within 12 m gain +1 melee and +1 pierce armour.',
    apply: (m) => { m.aegisArmor += 1; } },
  { id: 'rally', name: 'Rally', icon: 'crown', cat: 'banner', needs: () => true,
    desc: 'Ability: heal every ally within 11 m for 45 and steady their nerve (90 s).',
    apply: (m) => { m.rally = 1; } },
  { id: 'warlord', name: 'Warlord', icon: 'people', cat: 'banner', needs: () => true,
    desc: 'Your squadmates within 12 m gain +12% attack and +10% speed.',
    apply: (m) => { m.warlord = 1; } },

  /* ---- arcane: for the caster you possess --------------------------- */
  { id: 'attuned', name: 'Attuned', icon: 'relic', cat: 'arcane', needs: CASTER,
    desc: '+25% spell damage and healing.', apply: (m) => { m.spellPower *= 1.25; } },
  { id: 'deep_well', name: 'Deep Well', icon: 'book', cat: 'arcane', needs: CASTER,
    desc: '+40 maximum mana and +30% mana regeneration.',
    apply: (m) => { m.manaBonus += 40; m.manaRegenMul *= 1.3; } },
  { id: 'quickcast', name: 'Quickcast', icon: 'bolt', cat: 'arcane', needs: CASTER,
    desc: '22% shorter spell cooldowns.', apply: (m) => { m.cooldownMul *= 0.78; } },
  { id: 'effigy', name: 'Effigy', icon: 'coin', cat: 'arcane', needs: CASTER,
    desc: 'Spells cost 20% less mana.', apply: (m) => { m.spellCostMul *= 0.8; } },

  /* ---- craft: the villager you take into your own hands -------------- */
  { id: 'harvest', name: 'Harvester', icon: 'wheat', cat: 'craft', needs: VILLAGER,
    desc: '+30% gathering rate.', apply: (m) => { m.gatherMul *= 1.3; } },
  { id: 'strong_back', name: 'Strong Back', icon: 'cart', cat: 'craft', needs: VILLAGER,
    desc: '+8 carrying capacity.', apply: (m) => { m.carryBonus += 8; } },
  { id: 'mason', name: 'Master Mason', icon: 'hammer', cat: 'craft', needs: VILLAGER,
    desc: 'Builds and repairs 50% faster.', apply: (m) => { m.buildMul *= 1.5; } },
  { id: 'field_medic', name: 'Field Medic', icon: 'heart', cat: 'craft', needs: (u) => MONK(u) || VILLAGER(u) || true,
    desc: 'Heal 2.2 health per second when out of combat; monk healing is 25% stronger.',
    apply: (m) => { m.regen = Math.max(m.regen, 2.2); m.healMul *= 1.25; } }
];

const PERK_BY_ID = new Map(PERKS.map((p) => [p.id, p]));
export const perkById = (id) => PERK_BY_ID.get(id) || null;

/* Category weights per kind of body, so the offers read like a choice a
   person would actually be given: a mage is offered arcane, a peasant craft. */
function weightsFor(unit) {
  const w = { arms: 1, ward: 1, stride: 1, banner: 0.7, arcane: 0.05, craft: 0.05 };
  if (VILLAGER(unit)) { w.arms = 0.15; w.ward = 0.8; w.stride = 1.1; w.craft = 2.2; w.banner = 0.4; }
  if (MONK(unit)) { w.arms = 0.1; w.arcane = 0.5; w.craft = 1.4; w.banner = 1; }
  if (CASTER(unit)) { w.arcane = 2.4; w.craft = 0.05; w.arms = 0.4; }
  if (RANGED(unit)) { w.arms = 1.2; }
  return w;
}

/** A small deterministic RNG: offers are stable for a given (unit, rank). */
function hash32(a, b) {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return (h ^ (h >>> 16)) >>> 0;
}

/* ------------------------------------------------------------------
   modifier bag
   ------------------------------------------------------------------ */
function blankMods() {
  return {
    attackMul: 1, damageTakenMul: 1, armor: 0, pierceArmor: 0, speedMul: 1,
    sightBonus: 0, rangeBonus: 0, attackSpeedMul: 1,
    cleave: 0, longShot: 0, pierce: 0, executioner: 0, riposte: 0,
    secondWind: 0, undying: 0, blockMul: 0.38, blockDrainMul: 1,
    sprintMul: 1.55, staminaDrainMul: 1, dodgeCdMul: 1, dodgeInvuln: 0.38, surefoot: false,
    bannerAttack: 0, aegisArmor: 0, rally: 0, warlord: 0, regen: 0, healMul: 1,
    spellPower: 1, manaBonus: 0, manaRegenMul: 1, cooldownMul: 1, spellCostMul: 1,
    gatherMul: 1, carryBonus: 0, buildMul: 1
  };
}

/* ------------------------------------------------------------------
   the system
   ------------------------------------------------------------------ */
export class Champions {
  constructor(game) {
    this.game = game;
    this.current = null;        // the body you last stood inside
    this.cache = new WeakMap(); // unit -> { version, mods }
    this.version = 1;           // bumped whenever any champion changes perks
    this.acc = 0;
    this.pending = 0;           // unspent perk choices across all champions
    this.stats = { kills: 0, parries: 0, spells: 0, saved: 0 };
  }

  /* ---------------- identity ---------------- */

  /** Create (once) and return the champion record of a unit. */
  stateOf(unit) {
    if (!unit || unit.kind !== 'unit' || unit.dead) return null;
    if (unit.team !== this.game.playerTeam) return null;
    if (!unit.champion) {
      unit.champion = {
        renown: 0, picks: [], spent: 0, stamina: 100, staminaDelay: 0,
        dodgeReadyAt: 0, rallyReadyAt: 0, secondWindAt: 0, undyingAt: 0,
        lastHurtAt: -99, blockStart: 0, blocking: false, deaths: 0
      };
      this.version++;
    }
    return unit.champion;
  }

  /** The player put their hands on this body: it is now *the* Champion. */
  declare(unit) {
    const st = this.stateOf(unit);
    if (!st) return null;
    if (this.current && this.current !== unit && !this.current.dead) {
      /* One champion at a time. The old one keeps his rank and perks -- he
         simply stops being the person you are. Nothing is taken away. */
      this.current.isChampion = false;
    }
    this.current = unit;
    unit.isChampion = true;
    return st;
  }

  release(unit) {
    if (this.current === unit) this.current = null;
    if (unit) unit.championActive = false;
  }

  isChampion(unit) { return !!(unit && unit.champion); }

  rank(unit) {
    const st = unit && unit.champion;
    return st ? rankIndexFor(st.renown) : 0;
  }
  rankName(unit) { return CHAMPION_RANKS[this.rank(unit)].name; }
  pendingChoices(unit) {
    const st = unit && unit.champion;
    if (!st) return 0;
    return Math.max(0, this.rank(unit) - st.spent);
  }
  totalPending() {
    let n = 0;
    for (const u of this.game.units) if (!u.dead && u.champion) n += this.pendingChoices(u);
    return n;
  }

  /* ---------------- progression ---------------- */

  addRenown(unit, amount, why = '') {
    const st = unit && unit.champion;
    if (!st || unit.dead || !Number.isFinite(amount) || amount <= 0) return 0;
    if (unit.team !== this.game.playerTeam) return 0;
    /* Deeds performed in person are worth more: it is the difference between
       reading a report and being there. */
    const mul = this.game.directControl && this.game.directControl.unit === unit ? 1.35 : 1;
    const before = rankIndexFor(st.renown);
    st.renown = Math.min(40000, st.renown + amount * mul);
    const after = rankIndexFor(st.renown);
    if (after > before) this.onRankUp(unit, before, after);
    return after - before;
  }

  onRankUp(unit, from, to) {
    const g = this.game;
    const rank = CHAMPION_RANKS[to];
    this.version++;
    /* A rank is a real change to the body: a larger pool, and the difference
       healed, exactly like veterancy. */
    const bump = 1 + 0.06 * (to - from) * 1;
    if (unit.maxHp > 0) {
      const add = Math.round(unit.maxHp * (bump - 1));
      unit.maxHp += add;
      unit.hp = Math.min(unit.maxHp, unit.hp + add);
    }
    unit._stats = null;
    g.statsVersion++;
    if (g.fx?.glowPulse) g.fx.glowPulse(unit.x, (unit.y || 0) + 1.3, unit.z, 1, 0.86, 0.4);
    if (g.sound) g.sound.play('horn');
    if (g.notify) g.notify(`★ ${unit.name} is now ${rank.name} — choose a perk`, 'good');
    g.onEvent?.('championRank', { unit, rank: to, name: rank.name });
  }

  /** Three offers for a pending choice, filtered by the body and history. */
  offers(unit) {
    const st = unit && unit.champion;
    if (!st) return [];
    const rank = this.rank(unit);
    const weights = weightsFor(unit);
    const owned = new Set(st.picks);
    const eligible = PERKS.filter((p) => !owned.has(p.id) && p.needs(unit));
    if (eligible.length <= 3) return eligible.slice(0, 3);
    const seed = hash32(unit.id || 1, rank * 31 + st.picks.length);
    const picked = [];
    const pool = eligible.slice();
    /* Weighted sampling without replacement: draw from the categories this
       body should be offered, but never twice the same category in one card
       unless there is nothing else left. */
    for (let i = 0; i < 3 && pool.length; i++) {
      let total = 0;
      const w = pool.map((p) => {
        let weight = weights[p.cat] ?? 1;
        if (picked.some((q) => q.cat === p.cat)) weight *= 0.35;
        total += weight;
        return weight;
      });
      let r = ((seed >>> (i * 7)) % 10000) / 10000 * total;
      let idx = pool.length - 1;
      for (let k = 0; k < pool.length; k++) { r -= w[k]; if (r <= 0) { idx = k; break; } }
      picked.push(pool[idx]);
      pool.splice(idx, 1);
    }
    return picked;
  }

  choose(unit, perkId) {
    const st = unit && unit.champion;
    if (!st) return { ok: false, reason: 'That unit is not a Champion' };
    if (this.pendingChoices(unit) <= 0) return { ok: false, reason: 'No perk choice is waiting' };
    const perk = PERK_BY_ID.get(perkId);
    if (!perk) return { ok: false, reason: 'Unknown perk' };
    if (st.picks.includes(perkId)) return { ok: false, reason: 'Already taken' };
    if (!perk.needs(unit)) return { ok: false, reason: `${perk.name} does not suit this unit` };
    if (!this.offers(unit).some((p) => p.id === perkId)) return { ok: false, reason: 'Not one of the offered perks' };
    st.picks.push(perkId);
    st.spent++;
    this.version++;
    unit._stats = null;
    this.game.statsVersion++;
    return { ok: true, perk };
  }

  /* ---------------- modifiers ---------------- */

  mods(unit) {
    const st = unit && unit.champion;
    if (!st) return null;
    const hit = this.cache.get(unit);
    if (hit && hit.version === this.version && hit.spent === st.spent) return hit.mods;
    const m = blankMods();
    for (const id of st.picks) {
      const perk = PERK_BY_ID.get(id);
      if (perk) perk.apply(m, unit);
    }
    /* Champion rank itself: a person who has been in this many fights is
       harder to put down. Small and flat so the perks stay the story. */
    const r = this.rank(unit);
    m.attackMul *= 1 + 0.03 * r;
    this.cache.set(unit, { version: this.version, spent: st.spent, mods: m });
    return m;
  }

  /* ---------------- integration: stats ---------------- */
  applyStats(unit, s) {
    const m = this.mods(unit);
    if (!m) return s;
    s.attack *= m.attackMul;
    s.armor += m.armor;
    s.pierceArmor += m.pierceArmor;
    s.speed *= m.speedMul;
    s.sight += m.sightBonus;
    s.range += m.rangeBonus;
    s.championSpeedMul = m.speedMul;
    /* the banner and the aegis are auras from *another* body */
    const buff = unit.championBuff;
    if (buff && buff.until > this.game.time) {
      s.attack *= buff.attack || 1;
      s.armor += buff.armor || 0;
      s.pierceArmor += buff.armor || 0;
      s.speed *= buff.speed || 1;
    }
    return s;
  }

  /* ---------------- integration: incoming damage ---------------- */

  /**
   * Blocking, parry, flat reduction. Returns the damage that survives.
   * Called from Entity.takeDamage before hit points are subtracted, so the
   * armour maths above it has already run (a blocked blow still respects it).
   */
  mitigate(unit, amount, attacker, kind) {
    const m = this.mods(unit);
    if (!m) return amount;
    const st = unit.champion;
    const g = this.game;
    let out = amount * m.damageTakenMul;

    if (st.blocking && st.stamina > 1) {
      /* Only the front is covered -- that is the whole point of a shield. */
      let frontal = true;
      if (attacker) {
        const ax = attacker.x - unit.x, az = attacker.z - unit.z;
        const fx = Math.sin(unit.facing || 0), fz = Math.cos(unit.facing || 0);
        frontal = (ax * fx + az * fz) > 0.15 * Math.hypot(ax, az);
      }
      if (frontal) {
        const parry = st.blockStart && (g.time - st.blockStart) < 0.32;
        const mul = parry ? 0.12 : m.blockMul;
        const absorbed = out * (1 - mul);
        out *= mul;
        st.stamina = Math.max(0, st.stamina - absorbed * 0.16 * m.blockDrainMul);
        if (parry) {
          this.stats.parries++;
          this.addRenown(unit, 4 + absorbed * 0.06, 'parry');
          g.fx?.sparks(unit.x, unit.y + 1.2, unit.z, 4, [1, 0.95, 0.7]);
          if (attacker && !attacker.dead && attacker.attackCooldown !== undefined) {
            attacker.attackCooldown = Math.max(attacker.attackCooldown, 0.9);
            attacker.staggeredUntil = g.time + 0.9;
          }
          if (g.directControl?.unit === unit) g.directControl.feedback('PARRY', 'parry');
        } else {
          this.addRenown(unit, absorbed * 0.10, 'block');
          if (g.directControl?.unit === unit) g.directControl.feedback('BLOCK', 'block');
        }
        if (st.stamina <= 0.5) { st.blocking = false; st.blockStart = 0; }
      }
    }

    if (m.secondWind && unit.hp - out <= unit.maxHp * 0.28 && g.time >= st.secondWindAt) {
      st.secondWindAt = g.time + 45;
      const heal = Math.round(unit.maxHp * 0.22);
      unit.hp = Math.min(unit.maxHp, unit.hp + heal);
      g.fx?.heal(unit.x, unit.y + 1.2, unit.z, 10);
      g.notify?.(`${unit.name}: Second Wind (+${heal})`, 'good');
      if (g.directControl?.unit === unit) g.directControl.feedback(`+${heal}`, 'heal');
    }
    this.addRenown(unit, Math.min(out, 40) * 0.05, 'endure');
    st.lastHurtAt = g.time;
    return Math.max(0, out);
  }

  /** A killing blow was about to land. Returns true when it was refused. */
  rescue(unit) {
    const st = unit.champion;
    if (!st) return false;
    const m = this.mods(unit);
    if (!m || !m.undying) return false;
    if (this.game.time < st.undyingAt) return false;
    st.undyingAt = this.game.time + 120;
    unit.hp = 1;
    unit.invulnerableUntil = this.game.time + 0.6;
    this.stats.saved++;
    this.game.fx?.glowPulse?.(unit.x, unit.y + 1.2, unit.z, 1, 0.4, 0.3);
    this.game.notify?.(`${unit.name} refuses to fall (Undying)`, 'bad');
    if (this.game.directControl?.unit === unit) this.game.directControl.feedback('UNDYING', 'undying');
    return true;
  }

  /** The riposte: a melee attacker pays for the blow. */
  retaliation(unit, attacker, dealt) {
    const m = this.mods(unit);
    if (!m || !m.riposte || !attacker || attacker.dead) return 0;
    if (unit._riposteLock) return 0;
    unit._riposteLock = true;
    const back = dealt * m.riposte;
    attacker.takeDamage(back, unit, 'melee');
    unit._riposteLock = false;
    this.addRenown(unit, back * 0.2, 'riposte');
    return back;
  }

  /* ---------------- integration: outgoing damage ---------------- */

  /** Adjust the damage a champion is about to deal. Returns the new total. */
  modifyOutgoing(unit, target, dmg) {
    const m = this.mods(unit);
    if (!m) return dmg;
    let out = dmg + m.pierce;
    if (m.longShot && Math.hypot(target.x - unit.x, target.z - unit.z) > 8) out *= m.longShot;
    if (m.executioner && target.maxHp && target.hp / target.maxHp < 0.35) out *= m.executioner;
    return out;
  }

  /** Cleave, after the main blow has landed. */
  splash(unit, target, dmg) {
    const m = this.mods(unit);
    if (!m || !m.cleave) return 0;
    const g = this.game;
    let hit = 0;
    for (const other of g.units) {
      if (other.dead || other === target || other === unit) continue;
      if (!g.isHostile(unit.team, other.team)) continue;
      if (Math.hypot(other.x - target.x, other.z - target.z) > 2.6) continue;
      other.takeDamage(dmg * m.cleave, unit, 'melee');
      hit++;
      if (hit >= 5) break;
    }
    return hit;
  }

  /* ---------------- integration: economy ---------------- */

  gatherMul(unit) { const m = this.mods(unit); return m ? m.gatherMul : 1; }
  carryBonus(unit) { const m = this.mods(unit); return m ? m.carryBonus : 0; }
  buildMul(unit) { const m = this.mods(unit); return m ? m.buildMul : 1; }
  healMul(unit) { const m = this.mods(unit); return m ? m.healMul : 1; }
  spellPower(source) {
    if (!source || !source.champion) return 1;
    const m = this.mods(source);
    return m ? m.spellPower : 1;
  }
  manaMax(unit) {
    const m = this.mods(unit);
    return m ? m.manaBonus : 0;
  }
  manaRegenMul(unit) { const m = this.mods(unit); return m ? m.manaRegenMul : 1; }
  cooldownMul(unit) { const m = this.mods(unit); return m ? m.cooldownMul : 1; }
  spellCostMul(unit) { const m = this.mods(unit); return m ? m.spellCostMul : 1; }

  /* ---------------- abilities ---------------- */

  staminaMax() { return 100; }

  spend(unit, amount) {
    const st = unit && unit.champion;
    if (!st) return false;
    if (st.stamina < amount) return false;
    st.stamina -= amount;
    st.staminaDelay = 0.9;
    return true;
  }

  /**
   * Partial spend, used by sprint: returns 1 while the legs still have
   * something left, 0 when the sprint has to stop this tick.
   */
  spendStamina(unit, amount) {
    const st = unit && unit.champion;
    if (!st) return 0;
    if (st.stamina <= 1.5) return 0;
    st.stamina = Math.max(0, st.stamina - amount);
    st.staminaDelay = 0.9;
    return st.stamina > 0.5 ? 1 : 0;
  }

  canDodge(unit) {
    const st = unit && unit.champion;
    if (!st) return false;
    return this.game.time >= st.dodgeReadyAt && st.stamina >= 22;
  }
  dodgeCooldown(unit) {
    const st = unit && unit.champion;
    return st ? Math.max(0, st.dodgeReadyAt - this.game.time) : 0;
  }
  useDodge(unit) {
    const st = unit && unit.champion;
    if (!st || !this.canDodge(unit)) return false;
    const m = this.mods(unit);
    this.spend(unit, 22);
    st.dodgeReadyAt = this.game.time + 5 * (m ? m.dodgeCdMul : 1);
    unit.invulnerableUntil = this.game.time + (m ? m.dodgeInvuln : 0.38);
    return true;
  }

  canRally(unit) {
    const st = unit && unit.champion;
    const m = this.mods(unit);
    if (!st || !m || !m.rally) return false;
    return this.game.time >= st.rallyReadyAt;
  }
  rallyCooldown(unit) {
    const st = unit && unit.champion;
    return st ? Math.max(0, st.rallyReadyAt - this.game.time) : 0;
  }
  useRally(unit) {
    if (!this.canRally(unit)) return 0;
    const st = unit.champion;
    st.rallyReadyAt = this.game.time + 90;
    const g = this.game;
    let n = 0;
    for (const u of g.units) {
      if (u.dead || u.team !== unit.team) continue;
      if (Math.hypot(u.x - unit.x, u.z - unit.z) > 11) continue;
      u.heal(45);
      if (u.morale !== undefined) u.morale = Math.min(100, u.morale + 18);
      g.fx?.heal(u.x, u.y + 1, u.z, 3);
      n++;
    }
    g.fx?.glowPulse?.(unit.x, unit.y + 1.4, unit.z, 1, 0.85, 0.45);
    g.sound?.play?.('horn');
    g.notify?.(`Rally — ${n} ${n === 1 ? 'soldier' : 'soldiers'} steadied`, 'good');
    this.addRenown(unit, 12, 'rally');
    return n;
  }

  /* ---------------- per-tick ---------------- */

  update(dt) {
    const g = this.game;
    this.acc += dt;
    const tick = this.acc >= 0.25;
    if (tick) this.acc = 0;
    let buffs = null;
    if (tick) buffs = [];
    for (const u of g.units) {
      const st = u.champion;
      if (!st) continue;
      if (u.dead) continue;
      /* Stamina: a delay after spending, then a steady refill. */
      st.staminaDelay = Math.max(0, st.staminaDelay - dt);
      if (st.staminaDelay <= 0) {
        const m = this.mods(u);
        st.stamina = Math.min(100, st.stamina + dt * 15 * (st.blocking ? 0.35 : 1)
          * (m ? 1 / Math.max(0.5, m.staminaDrainMul) : 1));
      }
      if (!st.blocking) st.blockStart = 0;
      /* Field Medic: out of combat only. */
      const m = this.mods(u);
      if (m && m.regen > 0 && g.time - (st.lastHurtAt || -99) > 4 && u.hp < u.maxHp) {
        u.hp = Math.min(u.maxHp, u.hp + m.regen * dt);
      }
      if (tick && m && (m.bannerAttack || m.aegisArmor || m.warlord)) buffs.push(u);
    }
    if (tick && buffs.length) {
      const until = g.time + 0.6;
      for (const champ of buffs) {
        const m = this.mods(champ);
        for (const u of g.units) {
          if (u.dead || u.team !== champ.team || u === champ) continue;
          if (Math.hypot(u.x - champ.x, u.z - champ.z) > 12) continue;
          if (m.warlord && !(u.squad && u.squad === champ.squad)) { /* still counts as a soldier nearby */ }
          const buff = u.championBuff || (u.championBuff = { attack: 1, armor: 0, speed: 1, until: 0 });
          buff.attack = Math.max(buff.attack, m.bannerAttack || 1);
          buff.armor = Math.max(buff.armor, m.aegisArmor || 0);
          buff.speed = m.warlord && u.squad && u.squad === champ.squad ? Math.max(buff.speed, 1.1) : buff.speed;
          buff.until = until;
        }
      }
      g.statsVersion++;
    }
  }

  /* ---------------- save / load ---------------- */

  toJSON(unitIndex) {
    const rows = [];
    for (const [u, i] of unitIndex) {
      const st = u.champion;
      if (!st) continue;
      rows.push([i, {
        renown: Math.round(st.renown), picks: st.picks.slice(),
        spent: st.spent, dodgeReadyAt: 0, rallyReadyAt: 0
      }]);
    }
    return { current: this.current && unitIndex.has(this.current) ? unitIndex.get(this.current) : -1, rows };
  }

  fromJSON(data, units) {
    if (!data || !Array.isArray(data.rows)) return;
    for (const [idx, rec] of data.rows) {
      const u = units[idx];
      if (!u || u.dead) continue;
      const st = this.stateOf(u);
      if (!st) continue;
      st.renown = clamp(Number(rec.renown) || 0, 0, 40000);
      st.picks = (rec.picks || []).filter((id) => PERK_BY_ID.has(id));
      st.spent = Number.isInteger(rec.spent) ? clamp(rec.spent, 0, st.picks.length + 12) : st.picks.length;
    }
    const cur = Number.isInteger(data.current) && data.current >= 0 ? units[data.current] : null;
    if (cur && cur.champion) this.declare(cur);
    this.version++;
    for (const u of units) if (u && u.champion) u._stats = null;
  }
}
