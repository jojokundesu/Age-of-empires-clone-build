/* ============================================================
   data.js — the imperial database
   Units, buildings, technologies, ages and civilisations.
   Values are tuned for a ~25 minute mobile match: faster pacing
   than the desktop classic, but with the same counter triangle
   (infantry > cavalry > archers > infantry) and the same
   economic pressure of drop-off points and population.
   ============================================================ */

/* ============================================================
   TEAM COLOURS
   Up to four crowns share an island, and a player must be able to
   tell them apart at a glance in a battle line. Green is always
   the player and red is always the old enemy, so every habit
   built in a duel still holds; the two extra crowns take blue
   and gold, which are far apart from all four season tints.
   ============================================================ */
/* The one palette the whole game paints teams with: the model shader tints
   every roof and helm from it, the HUD dots and the crown strip use the same
   values, and the minimap has always drawn the player in that blue. Four
   crowns are therefore always the same four colours to the player, whichever
   of them they are commanding. */
export const TEAM_COLORS = {
  1: { ring: [0.42, 0.63, 1], unit: [0.32, 0.55, 0.98], css: '#5c8ffa', name: 'blue' },
  2: { ring: [1, 0.42, 0.34], unit: [0.95, 0.28, 0.22], css: '#f24738', name: 'red' },
  3: { ring: [0.6, 0.9, 0.4], unit: [0.5, 0.82, 0.3], css: '#80d14d', name: 'green' },
  4: { ring: [0.86, 0.64, 1], unit: [0.78, 0.52, 0.95], css: '#c785f2', name: 'purple' }
};
export const NEUTRAL_COLOR = { ring: [1, 0.86, 0.4], unit: [0.85, 0.72, 0.42], css: '#d9b86b', name: 'gold' };
export const teamColor = (team) => TEAM_COLORS[team] || NEUTRAL_COLOR;

export const RES = ['food', 'wood', 'gold', 'stone'];
export const RES_META = {
  food: { name: 'Food', icon: 'wheat', color: '#c8e07a' },
  wood: { name: 'Wood', icon: 'tree', color: '#a8c98a' },
  gold: { name: 'Gold', icon: 'coin', color: '#f0cb6a' },
  stone: { name: 'Stone', icon: 'stone', color: '#c2c8ce' },
  favor: { name: 'Favour', icon: 'bolt', color: '#d9a8ff' }
};

export const AGES = {
  0: { name: 'Dark Age', short: 'Dark', color: '#9c8f77' },
  1: { name: 'Feudal Age', short: 'Feudal', color: '#b9a05e', cost: { food: 420, gold: 160 }, time: 22 },
  2: { name: 'Castle Age', short: 'Castle', color: '#c9a86a', cost: { food: 700, gold: 380 }, time: 32 },
  3: { name: 'Imperial Age', short: 'Imperial', color: '#e8c47a', cost: { food: 1000, gold: 650 }, time: 42 }
};

export const CLASSES = ['infantry', 'cavalry', 'archer', 'siege', 'building', 'ship', 'monk', 'villager', 'unique'];

const U = (o) => ({ pop: 1, armor: 0, pierceArmor: 0, range: 0.9, sight: 11, time: 16, classes: [], bonuses: {}, ...o });

export const UNIT_DEFS = {
  villager: U({
    name: 'Villager', icon: 'villager', hp: 45, attack: 4, armor: 0, pierceArmor: 0,
    speed: 3.25, time: 12, cost: { food: 50 }, classes: ['villager'], sight: 9,
    desc: 'Gathers resources, builds and repairs. The backbone of every empire.'
  }),
  spearman: U({
    name: 'Spearman', icon: 'spear', hp: 100, attack: 9, armor: 1, pierceArmor: 1,
    speed: 2.95, time: 15, cost: { food: 40, wood: 25 }, classes: ['infantry'],
    attackSpeed: 1.18, bonuses: { cavalry: 18, ship: 4 }, sight: 11,
    desc: 'Cheap anti-cavalry infantry. Devastating against knights when massed.'
  }),
  swordsman: U({
    name: 'Swordsman', icon: 'sword', hp: 120, attack: 12, armor: 2, pierceArmor: 1,
    speed: 2.9, time: 19, cost: { food: 55, gold: 20 }, classes: ['infantry'],
    attackSpeed: 1.4, bonuses: { building: 4, archer: 2 }, sight: 11,
    desc: 'Armoured line infantry. The reliable core of a feudal army.'
  }),
  archer: U({
    name: 'Archer', icon: 'bow', hp: 68, attack: 9, armor: 0, pierceArmor: 0, range: 8.0,
    speed: 2.95, time: 18, cost: { food: 30, wood: 40 }, classes: ['archer'],
    attackSpeed: 1.3, projectile: 'arrow', bonuses: { infantry: 4, spear: 2 }, sight: 13,
    desc: 'Ranged damage from behind a shield wall. Fragile in melee.'
  }),
  skirmisher: U({
    name: 'Skirmisher', icon: 'target', hp: 65, attack: 4, armor: 0, pierceArmor: 3, range: 6.4,
    speed: 2.9, time: 16, cost: { food: 25, wood: 35 }, classes: ['archer'],
    projectile: 'javelin', bonuses: { archer: 8 }, sight: 12,
    desc: 'Cheap anti-archer skirmisher with a wicker shield.'
  }),
  knight: U({
    name: 'Knight', icon: 'shield', hp: 170, attack: 15, armor: 3, pierceArmor: 2,
    speed: 4.5, time: 24, cost: { food: 60, gold: 75 }, classes: ['cavalry'], sight: 12,
    attackSpeed: 1.45, bonuses: { archer: 8, siege: 4 },
    desc: 'Heavy shock cavalry. Crushes archers and siege, fears spears.'
  }),
  scout_cavalry: U({
    name: 'Scout Cavalry', icon: 'horse', hp: 90, attack: 7, armor: 1, pierceArmor: 1,
    speed: 5.1, time: 14, cost: { food: 80 }, classes: ['cavalry'], sight: 15,
    bonuses: { monk: 6, siege: 3 },
    desc: 'Fast light cavalry, perfect for scouting and raiding villagers.'
  }),
  monk: U({
    name: 'Monk', icon: 'monk', hp: 60, attack: 0, armor: 0, pierceArmor: 0, range: 6,
    speed: 2.5, time: 24, cost: { gold: 100 }, classes: ['monk'], sight: 12, heal: 12,
    desc: 'Heals allies and converts enemy units. Carries relics to the monastery.'
  }),
  hand_cannoneer: U({
    name: 'Hand Cannoneer', icon: 'cannon', hp: 80, attack: 18, armor: 1, pierceArmor: 1, range: 7.2,
    speed: 2.9, time: 26, cost: { food: 45, gold: 60 }, classes: ['archer'],
    projectile: 'ball', bonuses: { infantry: 9 }, sight: 13,
    desc: 'Gunpowder infantry. Slow to fire, brutal against massed infantry.'
  }),
  hero_general: U({
    name: 'Lord Commander', icon: 'crown', hp: 420, attack: 26, armor: 5, pierceArmor: 4,
    speed: 4.4, time: 40, cost: { food: 150, gold: 150 }, classes: ['cavalry', 'unique'],
    auraRange: 9, auraBonus: 0.18, sight: 15, bonuses: { archer: 8, infantry: 4 },
    desc: 'Your king. Inspires nearby troops (+18% attack) and cannot be converted.'
  }),
  longbowman: U({
    name: 'Longbowman', icon: 'bow', hp: 75, attack: 9, armor: 0, pierceArmor: 0, range: 9.2,
    speed: 2.85, time: 19, cost: { food: 35, wood: 45 }, classes: ['archer', 'unique'],
    projectile: 'arrow', bonuses: { infantry: 3 }, sight: 15,
    desc: 'Briton unique. Outranges every tower and rains death from afar.'
  }),
  axeman: U({
    name: 'Throwing Axeman', icon: 'axe', hp: 100, attack: 11, armor: 1, pierceArmor: 2, range: 3.4,
    speed: 2.95, time: 17, cost: { food: 55, gold: 25 }, classes: ['infantry', 'unique'],
    projectile: 'axe', bonuses: { building: 5, cavalry: 3 }, sight: 11,
    desc: 'Frankish unique. Hurls axes over the shield wall from short range.'
  }),
  cataphract: U({
    name: 'Cataphract', icon: 'helmet', hp: 200, attack: 15, armor: 5, pierceArmor: 4,
    speed: 4.3, time: 26, cost: { food: 70, gold: 80 }, classes: ['cavalry', 'unique'],
    bonuses: { infantry: 12 }, sight: 12,
    desc: 'Byzantine unique. A fortress on horseback; tramples infantry.'
  }),
  huskarl: U({
    name: 'Huskarl', icon: 'shield', hp: 110, attack: 12, armor: 4, pierceArmor: 5,
    speed: 3.2, time: 16, cost: { food: 50, gold: 25 }, classes: ['infantry', 'unique'],
    bonuses: { archer: 12, building: 3 }, sight: 11,
    desc: 'Gothic unique. Shield wall that laughs at arrows.'
  }),
  war_elephant: U({
    name: 'War Elephant', icon: 'people', hp: 620, attack: 22, armor: 3, pierceArmor: 1,
    speed: 2.4, time: 34, cost: { food: 180, gold: 90 }, classes: ['cavalry', 'unique'],
    splash: 2.4, bonuses: { building: 30, infantry: 8 }, sight: 12,
    desc: 'Persian unique. A living siege engine that scatters infantry.'
  }),
  samurai: U({
    name: 'Samurai', icon: 'sword', hp: 120, attack: 15, armor: 2, pierceArmor: 2,
    speed: 3.1, time: 18, cost: { food: 60, gold: 30 }, classes: ['infantry', 'unique'],
    bonuses: { unique: 14, building: 4 }, sight: 12,
    desc: 'Japanese unique. Duelist who cuts down other unique units.'
  }),
  mangudai: U({
    name: 'Mangudai', icon: 'horse', hp: 95, attack: 9, armor: 1, pierceArmor: 1, range: 6.6,
    speed: 4.9, time: 22, cost: { wood: 55, gold: 65 }, classes: ['cavalry', 'archer', 'unique'],
    projectile: 'arrow', bonuses: { siege: 14 }, sight: 14,
    desc: 'Mongol unique. Horse archer that kites and shreds siege.'
  }),
  berserk: U({
    name: 'Berserker', icon: 'axe', hp: 130, attack: 14, armor: 2, pierceArmor: 1,
    speed: 3.2, time: 17, cost: { food: 65, gold: 25 }, classes: ['infantry', 'unique'],
    regen: 1.4, bonuses: { building: 4 }, sight: 11,
    desc: 'Viking unique. Regenerates health in battle and never breaks.'
  }),
  ram: U({
    name: 'Battering Ram', icon: 'ram', hp: 420, attack: 26, armor: 8, pierceArmor: 12,
    speed: 1.55, time: 34, cost: { wood: 140, gold: 60 }, classes: ['siege'], pop: 2,
    bonuses: { building: 120 }, sight: 8, siege: true,
    desc: 'Chews through walls and gates. Nearly immune to arrows.'
  }),
  mangonel: U({
    name: 'Mangonel', icon: 'catapult', hp: 110, attack: 32, armor: 1, pierceArmor: 4, range: 10.5,
    minRange: 2.6, speed: 1.6, time: 36, cost: { wood: 160, gold: 120 }, classes: ['siege'], pop: 2,
    projectile: 'boulder', splash: 2.6, bonuses: { building: 40 }, sight: 13, siege: true,
    desc: 'Lobs stones into clumps of infantry. Beware of cavalry charges.'
  }),
  bombard_cannon: U({
    name: 'Bombard Cannon', icon: 'cannon', hp: 130, attack: 42, armor: 2, pierceArmor: 6, range: 13,
    minRange: 2.6, speed: 1.5, time: 42, cost: { wood: 200, gold: 200 }, classes: ['siege'], pop: 2,
    projectile: 'ball', splash: 1.8, bonuses: { building: 180 }, sight: 15, siege: true,
    desc: 'Gunpowder siege. Flattens fortifications from beyond tower range.'
  }),
  trebuchet: U({
    name: 'Trebuchet', icon: 'catapult', hp: 160, attack: 90, armor: 2, pierceArmor: 8, range: 16,
    minRange: 3.4, speed: 1.15, time: 46, cost: { wood: 200, gold: 200 }, classes: ['siege'], pop: 3,
    projectile: 'boulder', splash: 2.0, bonuses: { building: 240 }, sight: 17, siege: true,
    desc: 'The queen of siege. Must be packed up to move, then unpacked to fire.'
  }),
  fishing_boat: U({
    name: 'Fishing Boat', icon: 'fish', hp: 60, attack: 0, armor: 0, pierceArmor: 2,
    speed: 3.2, time: 14, cost: { wood: 75 }, classes: ['ship'], naval: true,
    gather: { food: 0.7 }, sight: 10,
    desc: 'Harvests fish and returns them to the dock.'
  }),
  transport_ship: U({
    name: 'Transport Ship', icon: 'ship', hp: 200, attack: 0, armor: 2, pierceArmor: 6,
    speed: 3.7, time: 20, cost: { wood: 110 }, classes: ['ship'], naval: true, capacity: 10,
    sight: 11, desc: 'Carries ten land units across water.'
  }),
  war_galley: U({
    name: 'War Galley', icon: 'ship', hp: 150, attack: 9, armor: 1, pierceArmor: 4, range: 7.4,
    speed: 3.8, time: 22, cost: { wood: 90, gold: 30 }, classes: ['ship'], naval: true,
    projectile: 'arrow', bonuses: { ship: 4 }, sight: 12,
    desc: 'Backbone of the fleet. Arrows sink anything that floats.'
  }),
  fire_ship: U({
    name: 'Fire Ship', icon: 'flame', hp: 175, attack: 18, armor: 2, pierceArmor: 5, range: 1.6,
    speed: 4.2, time: 20, cost: { wood: 100, gold: 45 }, classes: ['ship'], naval: true,
    bonuses: { ship: 22 }, sight: 10,
    desc: 'Sprints into enemy hulls and burns them. Fragile at range.'
  }),
  demo_ship: U({
    name: 'Demolition Ship', icon: 'bolt', hp: 70, attack: 130, armor: 0, pierceArmor: 2, range: 1.4,
    speed: 4.6, time: 18, cost: { wood: 80, gold: 50 }, classes: ['ship'], naval: true,
    suicide: true, bonuses: { ship: 160 }, sight: 9,
    desc: 'A floating bomb. One hit, one kill, one ship lost.'
  }),
  cannon_galleon: U({
    name: 'Cannon Galleon', icon: 'cannon', hp: 180, attack: 38, armor: 2, pierceArmor: 6, range: 12,
    minRange: 2.4, speed: 2.6, time: 38, cost: { wood: 180, gold: 140 }, classes: ['ship'], naval: true,
    projectile: 'ball', splash: 1.6, bonuses: { building: 120, ship: 12 }, sight: 14,
    desc: 'Floating artillery that can level a coastal castle.'
  }),
  /* ==========================================================
     THE CROWN'S OWN ENEMIES
     These two are never trained and never appear in a barracks
     list: a realm that has lost its footing raises them itself.
     They cost no population and no resources, because they are
     not an army the crown bought -- they are the bill for one it
     could not pay. The mob is numerous, cheap and cowardly; the
     claimant is a single dangerous man with a claim on the throne.
     ========================================================== */
  mob_rioter: U({
    name: 'Rioter', icon: 'flame', hp: 95, attack: 8, armor: 0, pierceArmor: 0,
    speed: 3.05, time: 0, cost: {}, classes: ['infantry'], pop: 0,
    bonuses: { building: 17 }, sight: 9, morale: 42,
    desc: 'An angry villager with a pitchfork and a torch. Burns buildings, breaks easily.'
  }),
  claimant_knight: U({
    name: 'Rival Claimant', icon: 'crown', hp: 320, attack: 21, armor: 5, pierceArmor: 3,
    speed: 4.5, time: 0, cost: {}, classes: ['cavalry', 'unique'], pop: 0,
    auraRange: 10, auraBonus: 0.2, sight: 14, bonuses: { archer: 8, infantry: 4, building: 10 },
    desc: 'A lord who says the throne is his. Rides with his own household knights.'
  }),
  trade_cart: U({
    name: 'Trade Cart', icon: 'cart', hp: 90, attack: 0, armor: 1, pierceArmor: 2,
    speed: 3.3, time: 20, cost: { wood: 100, gold: 50 }, classes: ['villager'],
    trade: true, sight: 9,
    desc: 'Generates gold by travelling between markets.'
  })
};

/** `techs` are ids from TECHS that must be researched to unlock. */
const B = (o) => ({ hp: 1000, armor: 2, pierceArmor: 6, size: 3, sight: 9, time: 26, pop: 0, ...o });

export const BUILDING_DEFS = {
  town_center: B({
    name: 'Town Centre', icon: 'castle', hp: 2400, armor: 5, pierceArmor: 9, size: 5.8, pop: 5, sight: 16,
    attack: 7, range: 8.5, cost: { wood: 275, stone: 100 }, time: 40, supply: 34,
    trains: ['villager'], dropoff: ['food', 'wood', 'gold', 'stone'], ageAdvance: true, garrison: 12,
    research: ['loom', 'wheelbarrow', 'hand_cart'],
    desc: 'Heart of the empire. Trains villagers, accepts resources and advances your age.'
  }),
  house: B({
    name: 'House', icon: 'house', hp: 550, armor: 2, pierceArmor: 6, size: 2.8, pop: 5, sight: 4,
    cost: { wood: 25 }, time: 12, desc: 'Adds +5 population. Build these constantly.'
  }),
  farm: B({
    name: 'Farm', icon: 'wheat', hp: 250, armor: 0, pierceArmor: 1, size: 3.4, sight: 3,
    cost: { wood: 60 }, time: 10, resKind: 'food', yield: 420, walkable: true,
    desc: 'A renewable food source. Reseeds automatically when exhausted.'
  }),
  mill: B({
    name: 'Mill', icon: 'cog', hp: 700, armor: 1, pierceArmor: 4, size: 3.2, sight: 7,
    cost: { wood: 80 }, time: 16, dropoff: ['food'], reliesOnRes: true,
    research: ['horse_collar', 'heavy_plow'],
    desc: 'Food drop-off point. Also researches farm and gather upgrades.'
  }),
  lumber_camp: B({
    name: 'Lumber Camp', icon: 'tree', hp: 600, armor: 1, pierceArmor: 4, size: 3.2, sight: 6,
    cost: { wood: 80 }, time: 15, dropoff: ['wood'], research: ['double_bit_axe', 'bow_saw'],
    desc: 'Wood drop-off point. Build it right next to the forest.'
  }),
  mining_camp: B({
    name: 'Mining Camp', icon: 'pick', hp: 600, armor: 1, pierceArmor: 4, size: 3.2, sight: 6,
    cost: { wood: 80 }, time: 15, dropoff: ['gold', 'stone'], research: ['gold_mining', 'stone_mining'],
    desc: 'Gold and stone drop-off point. Place it beside the mine.'
  }),
  barracks: B({
    name: 'Barracks', icon: 'sword', hp: 1200, armor: 3, pierceArmor: 7, size: 4.2, sight: 9,
    cost: { wood: 120 }, time: 22, trains: ['spearman', 'swordsman', 'hero_general'],
    desc: 'Trains infantry. Unlocks the Spearman and Swordsman lines.'
  }),
  archery_range: B({
    name: 'Archery Range', icon: 'bow', hp: 1100, armor: 2, pierceArmor: 7, size: 4.0, sight: 9,
    cost: { wood: 120 }, time: 22, trains: ['archer', 'skirmisher', 'hand_cannoneer'],
    desc: 'Trains archers and skirmishers. Gunpowder in the Imperial Age.'
  }),
  stable: B({
    name: 'Stable', icon: 'horse', hp: 1250, armor: 3, pierceArmor: 7, size: 4.2, sight: 9,
    cost: { wood: 120 }, time: 22, trains: ['scout_cavalry', 'knight'],
    desc: 'Trains cavalry. Fast, expensive and decisive.'
  }),
  blacksmith: B({
    name: 'Blacksmith', icon: 'anvil', hp: 1100, armor: 3, pierceArmor: 7, size: 3.6, sight: 8,
    cost: { wood: 120 }, time: 20, research: ['forging', 'scale_armor', 'fletching', 'barding_armor', 'iron_casting', 'chain_mail', 'bodkin_arrow'],
    desc: 'Weapon and armour upgrades for your entire army.'
  }),
  market: B({
    name: 'Market', icon: 'market', hp: 1150, armor: 2, pierceArmor: 6, size: 4.2, sight: 9,
    cost: { wood: 120 }, time: 20, market: true, trains: ['trade_cart'], research: ['caravan', 'guilds'],
    desc: 'Buy and sell resources, and train trade carts for passive gold.'
  }),
  university: B({
    name: 'University', icon: 'book', hp: 1400, armor: 3, pierceArmor: 8, size: 4.5, sight: 9,
    cost: { wood: 160 }, time: 26, research: ['ballistics', 'masonry', 'chemistry', 'murder_holes', 'architecture'],
    desc: 'Advanced military science: ballistics, chemistry and fortification.'
  }),
  monastery: B({
    name: 'Monastery', icon: 'temple', hp: 1200, armor: 2, pierceArmor: 7, size: 4.0, sight: 9,
    cost: { wood: 140 }, time: 22, trains: ['monk'], relicDrop: true, research: ['sanctity', 'fervor', 'illumination'],
    desc: 'Trains monks and stores relics for a steady stream of gold.'
  }),
  watch_tower: B({
    name: 'Watch Tower', icon: 'tower', hp: 900, armor: 4, pierceArmor: 8, size: 2.4, sight: 13,
    attack: 8, range: 9, cost: { wood: 100, stone: 50 }, time: 22, garrison: 3,
    desc: 'Cheap defensive tower that shoots arrows. Garrisoned troops add firepower.'
  }),
  stone_wall: B({
    name: 'Stone Wall', icon: 'wall', hp: 1000, armor: 8, pierceArmor: 12, size: 2.0, sight: 2,
    cost: { stone: 6 }, time: 6, walkable: false, wall: true,
    desc: 'Blocks armies. Build in lines to funnel the enemy.'
  }),
  palissade_wall: B({
    name: 'Palisade', icon: 'wall', hp: 350, armor: 2, pierceArmor: 6, size: 2.0, sight: 2,
    cost: { wood: 4 }, time: 5, walkable: false, wall: true,
    desc: 'Cheap wooden wall. Stops raiders, not siege.'
  }),
  stone_gate: B({
    name: 'Gate', icon: 'gate', hp: 1600, armor: 8, pierceArmor: 12, size: 2.8, sight: 8,
    cost: { stone: 30 }, time: 20, walkable: false, gate: true,
    desc: 'A gate your own troops pass through freely — the enemy cannot.'
  }),
  supply_tent: B({
    name: 'Supply Tent', icon: 'tent', hp: 240, armor: 0, pierceArmor: 2, size: 2.4, sight: 6,
    cost: { wood: 55 }, time: 14, supply: 26,
    desc: 'Extends your supply line 26 m. Armies far from one lose heart and eventually break.'
  }),
  castle: B({
    name: 'Castle', icon: 'castle', hp: 4800, armor: 9, pierceArmor: 14, size: 6.8, pop: 10, supply: 40, sight: 15,
    attack: 18, range: 11, cost: { stone: 500, wood: 150 }, time: 70, garrison: 15,
    trains: ['hero_general', 'axeman', 'longbowman', 'cataphract', 'huskarl', 'war_elephant', 'samurai', 'mangudai', 'berserk'],
    research: ['conscription', 'sappers', 'hoardings', 'chivalry', 'yeomen', 'greek_fire', 'anarchy', 'mahouts', 'bushido', 'drill', 'berserkergang'],
    desc: 'A fortress that fires multiple arrows and trains your king.'
  }),
  siege_workshop: B({
    name: 'Siege Workshop', icon: 'catapult', hp: 1350, armor: 3, pierceArmor: 8, size: 4.5, sight: 9,
    cost: { wood: 160 }, time: 26, trains: ['ram', 'mangonel', 'bombard_cannon', 'trebuchet'],
    desc: 'Builds the machines that end sieges.'
  }),
  dock: B({
    name: 'Dock', icon: 'ship', hp: 1500, armor: 2, pierceArmor: 8, size: 4.4, sight: 11,
    cost: { wood: 120 }, time: 20, water: true, dropoff: ['food'],
    trains: ['fishing_boat', 'transport_ship', 'war_galley', 'fire_ship', 'demo_ship', 'cannon_galleon'],
    desc: 'Builds and repairs the fleet. Must be placed on the shoreline.'
  }),
  wonder: B({
    name: 'Wonder', icon: 'crown', hp: 7000, armor: 10, pierceArmor: 16, size: 7.6, sight: 15,
    cost: { wood: 1000, gold: 1000, stone: 1000 }, time: 120, wonder: true,
    desc: 'Survive 200 seconds after completion to win the game.'
  }),
  outpost_shrine: B({
    name: 'Shrine', icon: 'flame', hp: 1400, armor: 4, pierceArmor: 8, size: 2.6, sight: 13,
    cost: {}, time: 0, neutral: true, desc: 'An ancient shrine. Capture it for vision and favour.'
  })
};

export const CIVS = {
  franks: {
    name: 'Franks', icon: 'crown', color: '#5b7ee0',
    unique: 'axeman', uniqueName: 'Throwing Axeman',
    bonus: 'Cavalry +20% HP · Farms +100 food · Castles −15% cost',
    bonuses: { cavalryHp: 1.2, farmYield: 100, castleDiscount: 0.85 },
    tech: { id: 'chivalry', name: 'Chivalry', desc: 'Stables work 40% faster.', cost: { food: 400, gold: 300 } },
    story: 'Knights of the Rhine, masters of the heavy charge.'
  },
  britons: {
    name: 'Britons', icon: 'bow', color: '#4ea86b',
    unique: 'longbowman', uniqueName: 'Longbowman',
    bonus: 'Foot archers +1 range · Archery Ranges work 20% faster · Shepherds +25%',
    bonuses: { archerRange: 1, archerySpeed: 1.2, shepherd: 1.25 },
    tech: { id: 'yeomen', name: 'Yeomen', desc: 'Archers +1 range and +20% attack.', cost: { food: 500, wood: 400 } },
    story: 'Island archers whose arrows darken the sky.'
  },
  byzantines: {
    name: 'Byzantines', icon: 'shield', color: '#a05fc0',
    unique: 'cataphract', uniqueName: 'Cataphract',
    bonus: 'Buildings +20% HP · Skirmishers & spearmen cost −15% · Monks heal 30% faster',
    bonuses: { buildingHp: 1.2, trashDiscount: 0.85, monkHeal: 1.3 },
    tech: { id: 'greek_fire', name: 'Greek Fire', desc: 'Fire ships deal +50% damage.', cost: { wood: 300, gold: 400 } },
    story: 'Heirs of the old empire, armoured in gold and iron.'
  },
  goths: {
    name: 'Goths', icon: 'sword', color: '#c0693e',
    unique: 'huskarl', uniqueName: 'Huskarl',
    bonus: 'Infantry cost −20% · Barracks work 25% faster · +10 population cap',
    bonuses: { infantryDiscount: 0.8, barracksSpeed: 1.25, popBonus: 10 },
    tech: { id: 'anarchy', name: 'Anarchy', desc: 'Barracks train Huskarls. Infantry +10% HP.', cost: { food: 450, gold: 300 } },
    story: 'A tide of axes that never stops coming.'
  },
  persians: {
    name: 'Persians', icon: 'people', color: '#c9a227',
    unique: 'war_elephant', uniqueName: 'War Elephant',
    bonus: 'Town Centres +50% HP · Start with +100 food & wood · Villagers +10% speed',
    bonuses: { tcHp: 1.5, startBonus: { food: 100, wood: 100 }, villagerSpeed: 1.1 },
    tech: { id: 'mahouts', name: 'Mahouts', desc: 'War Elephants +30% HP and speed.', cost: { food: 500, gold: 400 } },
    story: 'Elephants from the eastern deserts, clad in iron.'
  },
  japanese: {
    name: 'Japanese', icon: 'temple', color: '#d05a6a',
    unique: 'samurai', uniqueName: 'Samurai',
    bonus: 'Infantry attack +15% · Fishing boats +50% gather · Villagers +5% HP',
    bonuses: { infantryAttack: 1.15, fishingBonus: 1.5 },
    tech: { id: 'bushido', name: 'Bushido', desc: 'Samurai +3 armour and +15% attack.', cost: { food: 400, gold: 350 } },
    story: 'Disciplined warriors of the rising sun.'
  },
  mongols: {
    name: 'Mongols', icon: 'horse', color: '#4b9ec4',
    unique: 'mangudai', uniqueName: 'Mangudai',
    bonus: 'Cavalry archers +15% speed · Siege +20% speed · Hunters +40% yield',
    bonuses: { cavArchSpeed: 1.15, siegeSpeed: 1.2, huntBonus: 1.4 },
    tech: { id: 'drill', name: 'Drill', desc: 'Cavalry +25% speed, siege +30% speed.', cost: { wood: 400, gold: 350 } },
    story: 'Riders of the steppe who strike before you can see them.'
  },
  vikings: {
    name: 'Vikings', icon: 'axe', color: '#6f8fa8',
    unique: 'berserk', uniqueName: 'Berserker',
    bonus: 'Infantry +15% HP · Warships cost −15% · Regenerating warriors',
    bonuses: { infantryHp: 1.15, shipDiscount: 0.85 },
    tech: { id: 'berserkergang', name: 'Berserkergang', desc: 'Berserkers regenerate twice as fast and +20% HP.', cost: { food: 450, gold: 300 } },
    story: 'Raiders from the north, fearless in the shield wall.'
  }
};

export const TECH_DEFS = {
  forging: { name: 'Forging', icon: 'anvil', age: 1, cost: { food: 150 }, time: 25, at: 'blacksmith', effect: 'infantryAttack+1', desc: 'Infantry and cavalry +1 attack.' },
  scale_armor: { name: 'Scale Armour', icon: 'shield', age: 1, cost: { food: 100, gold: 50 }, time: 25, at: 'blacksmith', effect: 'infantryArmor+1', desc: 'Infantry and cavalry +1 armour.' },
  fletching: { name: 'Fletching', icon: 'bow', age: 1, cost: { food: 100, wood: 50 }, time: 25, at: 'blacksmith', effect: 'archerAttack+1', desc: 'Archers and towers +1 attack, +1 range.' },
  barding_armor: { name: 'Barding', icon: 'horse', age: 2, cost: { food: 200, gold: 100 }, time: 30, at: 'blacksmith', effect: 'cavalryArmor+1', desc: 'Cavalry +1 armour and +10% HP.' },
  iron_casting: { name: 'Iron Casting', icon: 'anvil', age: 2, cost: { food: 220, gold: 120 }, time: 32, at: 'blacksmith', effect: 'infantryAttack+1', desc: 'Infantry and cavalry +1 attack.' },
  chain_mail: { name: 'Chain Mail', icon: 'shield', age: 2, cost: { food: 150, gold: 100 }, time: 30, at: 'blacksmith', effect: 'infantryArmor+1', desc: 'Infantry and cavalry +1 armour.' },
  bodkin_arrow: { name: 'Bodkin Arrow', icon: 'bow', age: 2, cost: { food: 150, gold: 60 }, time: 30, at: 'blacksmith', effect: 'archerAttack+1', desc: 'Archers +1 attack, +1 range.' },
  caravan: { name: 'Caravan', icon: 'cart', age: 2, cost: { wood: 150, gold: 100 }, time: 25, at: 'market', effect: 'tradeCart', desc: 'Unlocks the Trade Cart and +30% trade gold.' },
  guilds: { name: 'Guilds', icon: 'coin', age: 3, cost: { food: 300, gold: 200 }, time: 40, at: 'market', effect: 'tradeGold+0.4', desc: 'Trade carts generate 40% more gold.' },
  ballistics: { name: 'Ballistics', icon: 'target', age: 2, cost: { wood: 300, gold: 175 }, time: 45, at: 'university', effect: 'ballistics', desc: 'Archers and towers lead moving targets.' },
  masonry: { name: 'Masonry', icon: 'wall', age: 2, cost: { food: 175, wood: 150 }, time: 40, at: 'university', effect: 'buildingHp+0.15', desc: 'Buildings +15% HP and +1 armour.' },
  chemistry: { name: 'Chemistry', icon: 'cannon', age: 3, cost: { food: 300, gold: 200 }, time: 45, at: 'university', effect: 'gunpowder', desc: 'Unlocks Hand Cannoneers and Bombard Cannons; archers +1 attack.' },
  murder_holes: { name: 'Murder Holes', icon: 'tower', age: 1, cost: { stone: 100, food: 100 }, time: 25, at: 'university', effect: 'murderHoles', desc: 'Defensive buildings can fire at adjacent enemies.' },
  architecture: { name: 'Architecture', icon: 'castle', age: 3, cost: { wood: 250, stone: 150 }, time: 50, at: 'university', effect: 'buildSpeed', desc: 'Buildings +20% HP and build 30% faster.' },
  conscription: { name: 'Conscription', icon: 'sword', age: 3, cost: { food: 250, gold: 150 }, time: 40, at: 'castle', effect: 'trainSpeed', desc: 'Military buildings train 33% faster.' },
  sappers: { name: 'Sappers', icon: 'ram', age: 3, cost: { food: 200, gold: 200 }, time: 40, at: 'castle', effect: 'sappers', desc: 'Villagers deal +15 damage to buildings.' },
  hoardings: { name: 'Hoardings', icon: 'wall', age: 3, cost: { food: 400, wood: 400 }, time: 50, at: 'castle', effect: 'buildingHp+0.2', desc: 'Defensive buildings +20% HP.' },
  sanctity: { name: 'Sanctity', icon: 'monk', age: 2, cost: { food: 120, gold: 80 }, time: 30, at: 'monastery', effect: 'monkHp', desc: 'Monks +30 HP.' },
  fervor: { name: 'Fervor', icon: 'bolt', age: 2, cost: { food: 150, gold: 100 }, time: 35, at: 'monastery', effect: 'monkSpeed', desc: 'Monks move 25% faster and carry relics quickly.' },
  illumination: { name: 'Illumination', icon: 'book', age: 3, cost: { food: 200, gold: 150 }, time: 40, at: 'monastery', effect: 'relicGold', desc: 'Relics generate twice as much gold.' },
  loom: { name: 'Loom', icon: 'heart', age: 0, cost: { food: 60 }, time: 15, at: 'town_center', effect: 'villagerHp', desc: 'Villagers +15 HP and +1 armour.' },
  wheelbarrow: { name: 'Wheelbarrow', icon: 'cart', age: 1, cost: { food: 175, wood: 75 }, time: 30, at: 'town_center', effect: 'carry', desc: 'Villagers move 10% faster and carry +7 resources.' },
  hand_cart: { name: 'Hand Cart', icon: 'cart', age: 2, cost: { food: 300, wood: 200 }, time: 40, at: 'town_center', effect: 'carry2', desc: 'Villagers carry +12 more and move faster.' },
  double_bit_axe: { name: 'Double-Bit Axe', icon: 'axe', age: 1, cost: { food: 100, wood: 60 }, time: 25, at: 'lumber_camp', effect: 'woodRate', desc: 'Villagers chop wood 20% faster.' },
  bow_saw: { name: 'Bow Saw', icon: 'axe', age: 2, cost: { food: 150, wood: 100 }, time: 30, at: 'lumber_camp', effect: 'woodRate', desc: 'Villagers chop wood 20% faster.' },
  gold_mining: { name: 'Gold Mining', icon: 'pick', age: 1, cost: { food: 100, wood: 75 }, time: 25, at: 'mining_camp', effect: 'goldRate', desc: 'Villagers mine gold 20% faster.' },
  stone_mining: { name: 'Stone Mining', icon: 'pick', age: 1, cost: { food: 100, wood: 75 }, time: 25, at: 'mining_camp', effect: 'stoneRate', desc: 'Villagers mine stone 20% faster.' },
  horse_collar: { name: 'Horse Collar', icon: 'wheat', age: 1, cost: { food: 75, wood: 75 }, time: 20, at: 'mill', effect: 'farmRate', desc: 'Farms +15% food and +75 yield.' },
  heavy_plow: { name: 'Heavy Plough', icon: 'wheat', age: 2, cost: { food: 125, wood: 125 }, time: 30, at: 'mill', effect: 'farmRate', desc: 'Farms +15% food and +125 yield.' },
  /* --- civilisation technologies, available at the Castle --- */
  chivalry: { name: 'Chivalry', icon: 'horse', age: 2, cost: { food: 400, gold: 300 }, time: 40, at: 'castle', civ: 'franks', effect: 'stableSpeed', desc: 'Stables work 40% faster; knights +10% HP.' },
  yeomen: { name: 'Yeomen', icon: 'bow', age: 3, cost: { food: 500, wood: 400 }, time: 45, at: 'castle', civ: 'britons', effect: 'archerRange', desc: 'Longbowmen +1 range and +20% attack.' },
  greek_fire: { name: 'Greek Fire', icon: 'fire', age: 2, cost: { wood: 300, gold: 400 }, time: 45, at: 'castle', civ: 'byzantines', effect: 'fireShip', desc: 'Fire ships deal +50% damage.' },
  anarchy: { name: 'Anarchy', icon: 'axe', age: 2, cost: { food: 450, gold: 300 }, time: 40, at: 'castle', civ: 'goths', effect: 'huskarlBarracks', desc: 'Barracks can train Huskarls; infantry +10% HP.' },
  mahouts: { name: 'Mahouts', icon: 'elephant', age: 2, cost: { food: 500, gold: 400 }, time: 45, at: 'castle', civ: 'persians', effect: 'elephant', desc: 'War Elephants +30% HP and speed.' },
  bushido: { name: 'Bushido', icon: 'sword', age: 2, cost: { food: 400, gold: 350 }, time: 40, at: 'castle', civ: 'japanese', effect: 'samurai', desc: 'Samurai +3 armour and +15% attack.' },
  drill: { name: 'Drill', icon: 'horse', age: 3, cost: { wood: 400, gold: 350 }, time: 45, at: 'castle', civ: 'mongols', effect: 'siegeSpeed', desc: 'Cavalry +25% speed and siege +30% speed.' },
  berserkergang: { name: 'Berserkergang', icon: 'axe', age: 3, cost: { food: 450, gold: 300 }, time: 45, at: 'castle', civ: 'vikings', effect: 'berserk', desc: 'Berserkers regenerate twice as fast and +20% HP.' }
};

export const UNIT_LINES = {
  barracks: ['spearman', 'swordsman'],
  archery_range: ['archer', 'skirmisher'],
  stable: ['scout_cavalry', 'knight'],
  siege_workshop: ['ram', 'mangonel']
};

export const BUILDING_CATEGORIES = [
  {
    name: 'Economy', items: ['house', 'farm', 'lumber_camp', 'mining_camp', 'mill', 'market', 'dock']
  },
  {
    name: 'Military', items: ['barracks', 'archery_range', 'stable', 'blacksmith', 'siege_workshop', 'monastery', 'university']
  },
  {
    name: 'Fortifications', items: ['watch_tower', 'palissade_wall', 'stone_wall', 'stone_gate', 'castle', 'wonder']
  }
];

/** Building unlock requirements by age (0-indexed). */
export const BUILDING_AGE = {
  town_center: 0, house: 0, farm: 0, lumber_camp: 0, mining_camp: 0, mill: 0,
  palissade_wall: 0, outpost_shrine: 0,
  barracks: 1, archery_range: 1, stable: 1, blacksmith: 1, market: 1, watch_tower: 1,
  stone_wall: 1, stone_gate: 1, supply_tent: 0, monastery: 2, siege_workshop: 2, university: 2, castle: 2,
  wonder: 3, dock: 1
};

export const UNIT_AGE = {
  villager: 0, spearman: 1, swordsman: 1, archer: 1, skirmisher: 1, scout_cavalry: 1,
  knight: 2, monk: 2, hand_cannoneer: 3, ram: 2, mangonel: 2, bombard_cannon: 3, trebuchet: 3,
  fishing_boat: 1, transport_ship: 1, war_galley: 1, fire_ship: 2, demo_ship: 2, cannon_galleon: 3,
  hero_general: 2, trade_cart: 2,
  mob_rioter: 1, claimant_knight: 3,
  longbowman: 2, axeman: 2, cataphract: 2, huskarl: 2, war_elephant: 2, samurai: 2, mangudai: 2, berserk: 2
};

export function unitForCiv(civ, baseType) {
  if (baseType !== 'unique') return baseType;
  const c = CIVS[civ];
  return c ? c.unique : 'hero_general';
}

/** Is this unit a civilisation unique? */
export function isUniqueUnit(type) {
  for (const k in CIVS) if (CIVS[k].unique === type) return true;
  return false;
}

/** Population ceiling by age. */
export const POP_CAP = [30, 60, 90, 120];

export const DIFFICULTY = {
  standard: {
    name: 'Standard', gather: 1.0, aggression: 0.62, buildSpeed: 1.0, reaction: 1.6,
    maxPop: 60, startRes: 260, startVillagers: 4, villagerTarget: 18,
    start: { food: 300, wood: 300, gold: 150, stone: 100 },
    firstWave: 420, waveEvery: 95, maxArmy: 16, towerChance: 0.25
  },
  hard: {
    name: 'Hard', gather: 1.16, aggression: 0.85, buildSpeed: 1.12, reaction: 1.0,
    maxPop: 80, startRes: 340, startVillagers: 5, villagerTarget: 22,
    start: { food: 300, wood: 300, gold: 150, stone: 100 },
    firstWave: 330, waveEvery: 78, maxArmy: 24, towerChance: 0.45
  },
  extreme: {
    name: 'Imperious', gather: 1.34, aggression: 1.0, buildSpeed: 1.25, reaction: 0.65,
    maxPop: 100, startRes: 460, startVillagers: 6, villagerTarget: 26,
    start: { food: 300, wood: 300, gold: 150, stone: 100 },
    firstWave: 250, waveEvery: 62, maxArmy: 34, towerChance: 0.6
  },
  sandbox: {
    name: 'Peaceful', gather: 1.0, aggression: 0.0, buildSpeed: 1.0, reaction: 2.0,
    maxPop: 60, startRes: 10000, startVillagers: 6, villagerTarget: 14,
    firstWave: 99999, waveEvery: 99999, maxArmy: 0, towerChance: 0
  }
};

export const GAME_MODES = {
  campaign: { name: 'Imperial Conquest', desc: 'Destroy every enemy building to claim the crown.' },
  kingdoms: { name: 'War of Crowns', desc: 'Three or four kingdoms on one island. The last crown standing rules alone.' },
  regicide: { name: 'Regicide', desc: 'Protect your king. Kill theirs.' },
  wonder: { name: 'Wonder Race', desc: 'Raise a wonder and hold it for 200 seconds.' },
  sandbox: { name: 'Grand Sandbox', desc: 'Ten thousand resources. Build a masterpiece.' },
  mods: { name: 'Mod Workshop', desc: 'The same war, with new rules.' }
};

/* ============================================================
   TERMS OF WAR
   The condition a match is fought under, chosen before the
   first villager is trained. They are not skins on one rule:
   each one changes what "winning" means, what "losing" means,
   and therefore where the army goes.

     Conquest    take every other crown off the map
     Regicide    one king per crown -- kill them
     Wonder      raise a wonder and hold it for 200 seconds
     Supremacy   when the clock runs out, the strongest crown rules
   ============================================================ */
export const VICTORIES = {
  conquest: {
    id: 'conquest', name: 'Conquest', icon: 'castle',
    desc: 'Take every other crown off the map: no buildings, no army.',
    short: 'destroy every rival'
  },
  regicide: {
    id: 'regicide', name: 'Regicide', icon: 'crown',
    desc: 'Every crown fields a king. Kill every rival king; lose yours and the war is over.',
    short: 'kill every rival king'
  },
  wonder: {
    id: 'wonder', name: 'Wonder', icon: 'temple',
    desc: 'Raise a wonder and hold it for 200 seconds while the island comes for you.',
    short: 'hold a wonder for 200s'
  },
  supremacy: {
    id: 'supremacy', name: 'Supremacy', icon: 'hourglass',
    desc: 'When the clock runs out, the crown with the strongest realm rules.',
    short: 'lead when the clock runs out'
  }
};
export const VICTORY_LIST = Object.values(VICTORIES);
/** Wonder mode means nothing without a clock, and regicide needs kings. */
export function victoryFor(mode) {
  if (mode === 'regicide') return 'regicide';
  if (mode === 'wonder') return 'wonder';
  return 'conquest';
}
