#!/usr/bin/env node
/**
 * Per-model real-world size rules (meters).
 *
 * Both asset packs ignore real scale: Kenney models are ~0.55× real size,
 * KayKit models are authored on a 1–4 m stylized grid. Since the renderer
 * normalizes every GLB to the registry footprint, a wrong footprint means a
 * wrong size on screen (giant toasters, doll chairs).
 *
 * Each rule: [idRegex, axis, target] — first match wins.
 *   s = target / bbox[axis]  (uniform scale; axis 'maxxz' = max(w, d))
 * The resulting footprint/height (= bbox × s) is stored in the manifest, so
 * the renderer's fit-inside normalization reproduces exactly this scale.
 */
const R = [
  // --------------------------------- PETS ----------------------------------
  // chibi kitten: big-head proportions read best slightly larger than a real cat
  [/^chibi-kitten/, 'y', 0.42],
  // toon cat: tall stylized standing cat (raw bbox is in centimeters)
  [/^toon-cat/, 'y', 0.46],

  // ------------------------------- BATHROOM --------------------------------
  [/^bathtub/, 'x', 1.7],
  [/^shower/, 'maxxz', 0.95],
  [/^toilet/, 'z', 0.68],
  [/^bathroom-sink/, 'x', 0.58],
  [/^bathroom-mirror/, 'x', 0.5],
  [/^washer-dryer-stacked/, 'x', 0.62],
  [/^(washer|dryer)/, 'x', 0.62],
  [/^towelrail/, 'x', 0.6],

  // --------------------------------- BEDS ----------------------------------
  [/^bed-bunk/, 'z', 2.0],
  [/^bed-double/, 'z', 2.05],
  [/^bed-single/, 'z', 2.0],
  [/^cabinet-bed/, 'x', 0.45],

  // ------------------------------- SEATING ---------------------------------
  [/^couch/, 'x', 2.2],
  [/^lounge-sofa-corner/, 'maxxz', 1.9],
  [/^lounge-sofa-long/, 'maxxz', 1.7],
  [/^lounge-sofa-ottoman/, 'x', 0.9],
  [/^lounge-sofa/, 'x', 2.0],
  [/^lounge-design-sofa-corner/, 'maxxz', 1.9],
  [/^lounge-design-sofa/, 'x', 2.0],
  [/^lounge-design-chair/, 'maxxz', 0.85],
  [/^lounge-chair-relax/, 'maxxz', 0.85],
  [/^lounge-chair/, 'maxxz', 0.85],
  [/^armchair/, 'maxxz', 0.95],
  [/^chair-[abc]/, 'y', 0.95], // kaykit dining chairs with arms
  [/^chair-stool/, 'maxxz', 0.55],
  [/^chair-desk/, 'y', 0.95],
  [/^chair/, 'y', 0.9],
  [/^bench-cushion-low/, 'x', 1.0],
  [/^bench/, 'x', 1.2],
  [/^stool-bar/, 'y', 0.78],
  [/^stool/, 'y', 0.45],

  // -------------------------------- TABLES ---------------------------------
  [/^table-coffee/, 'x', 1.2],
  [/^table-round/, 'y', 0.75],
  [/^table-cloth/, 'x', 1.6],
  [/^table$/, 'x', 1.6],
  [/^side-table/, 'y', 0.55],
  [/^desk-corner/, 'maxxz', 1.3],
  [/^desk/, 'y', 0.75],
  [/^kitchentable-(a|b)-large/, 'y', 0.75],
  [/^kitchentable-sink-large/, 'y', 0.9],
  [/^kitchentable-sink/, 'y', 0.9],
  [/^kitchentable/, 'y', 0.75],

  // -------------------------------- STORAGE --------------------------------
  [/^bookcase-open-low/, 'y', 0.9],
  [/^bookcase/, 'y', 1.9],
  [/^cabinet-television/, 'x', 1.4],
  [/^cabinet-medium/, 'maxxz', 1.2],
  [/^cabinet-small/, 'y', 0.9],
  [/^bathroom-cabinet/, 'y', 0.6],
  [/^coat-rack-standing/, 'y', 1.75],
  [/^coat-rack/, 'x', 0.5],
  [/^cardboard-box/, 'y', 0.35],
  [/^crate/, 'maxxz', 0.55],
  [/^dishrack/, 'maxxz', 0.45],
  [/^shelf-(a-big|b-large)/, 'x', 0.9],
  [/^shelf-(a-small|b-small)/, 'x', 0.6],
  [/^shelf-papertowel/, 'y', 0.3],

  // -------------------------------- KITCHEN --------------------------------
  [/^toaster/, 'x', 0.26],
  [/^kitchen-microwave/, 'x', 0.5],
  [/^kitchen-blender/, 'y', 0.35],
  [/^kitchen-coffee-machine/, 'y', 0.35],
  [/^kitchen-fridge-large/, 'y', 1.85],
  [/^kitchen-fridge-small/, 'y', 1.2],
  [/^kitchen-fridge/, 'y', 1.75],
  [/^fridge-[ab]/, 'maxxz', 0.85],
  [/^kitchen-stove/, 'x', 0.62],
  [/^(stove-multi|stove-single|oven)/, 'maxxz', 0.75],
  [/^kitchen-sink/, 'x', 0.62],
  [/^kitchen-cabinet-upper/, 'x', 0.8],
  [/^kitchen-cabinet-corner/, 'maxxz', 0.65],
  [/^kitchen-cabinet/, 'x', 0.62],
  [/^hood-(large|modern)/, 'x', 0.6],
  [/^extractorhood/, 'x', 0.7],
  [/^kitchen-bar-end/, 'x', 0.2],
  [/^kitchen-bar/, 'y', 0.9],
  [/^kitchencounter-(inner|outer)corner/, 'maxxz', 0.9],
  [/^kitchencounter/, 'maxxz', 1.3],
  [/^kitchencabinet-corner-half/, 'maxxz', 0.65],
  [/^kitchencabinet-corner/, 'maxxz', 0.85],
  [/^kitchencabinet-half/, 'maxxz', 0.6],
  [/^kitchencabinet/, 'maxxz', 0.85],
  [/^jar-/, 'y', 0.2],
  [/^(ketchup|mustard)/, 'y', 0.18],
  [/^papertowel/, 'y', 0.28],
  [/^bowl-small/, 'maxxz', 0.18],
  [/^bowl/, 'maxxz', 0.22],
  [/^plate-small/, 'maxxz', 0.2],
  [/^plate/, 'maxxz', 0.26],
  [/^pot-large/, 'maxxz', 0.42],
  [/^(pot|stew-pot)/, 'maxxz', 0.32],
  [/^stew-bowl/, 'maxxz', 0.25],
  [/^pan-/, 'maxxz', 0.42],
  [/^lid-/, 'maxxz', 0.3],
  [/^knife/, 'y', 0.35],
  [/^cuttingboard/, 'x', 0.4],
  [/^food-dinner/, 'maxxz', 0.35],
  [/^food-/, 'maxxz', 0.25],

  // -------------------------------- LIGHTING -------------------------------
  [/^ceiling-fan/, 'maxxz', 1.3],
  [/^lamp-(round|square)-floor/, 'y', 1.5],
  [/^lamp-(round|square)-table/, 'y', 0.45],
  [/^lamp-square-ceiling/, 'y', 0.3],
  [/^lamp-wall/, 'x', 0.3],
  [/^lamp-standing/, 'y', 1.6],
  [/^lamp-table/, 'y', 0.5],

  // --------------------------------- DECOR ---------------------------------
  [/^cactus-medium/, 'y', 0.9],
  [/^cactus-small/, 'y', 0.5],
  [/^plant-small/, 'y', 0.25],
  [/^potted-plant/, 'y', 0.8],
  [/^bear/, 'y', 0.4],
  [/^book/, 'y', 0.25],
  [/^radio/, 'x', 0.35],
  [/^speaker-small/, 'y', 0.35],
  [/^speaker/, 'y', 0.8],
  [/^television-modern/, 'x', 1.1],
  [/^television-vintage/, 'x', 0.7],
  [/^television-antenna/, 'x', 0.3],
  [/^laptop/, 'x', 0.35],
  [/^computer-screen/, 'x', 0.5],
  [/^computer-keyboard/, 'x', 0.4],
  [/^computer-mouse/, 'x', 0.1],
  [/^pillow-(blue-)?long/, 'x', 0.6],
  [/^pillow/, 'x', 0.45],
  [/^rug-doormat/, 'x', 0.6],
  [/^rug-rectangle/, 'x', 2.4],
  [/^rug-(round|rounded|square|oval)/, 'maxxz', 2.0],
  [/^trashcan/, 'y', 0.5],
  [/^menu/, 'y', 1.0],
  [/^pictureframe/, 'y', 0.7],

  // --------------------------------- OTHER ---------------------------------
  [/^door-[ab]/, 'y', 2.1],
  [/^pillar/, 'y', 2.7],
  [/^wall/, 'maxxz', 2.0],
  [/^floor/, 'maxxz', 1.0],
]

/** Ids that hang from the ceiling instead of standing on the floor. */
const CEILING = /^(ceiling-fan|lamp-square-ceiling|extractorhood)/

const axisValue = (axis, w, h, d) =>
  axis === 'x' ? w : axis === 'y' ? h : axis === 'z' ? d : Math.max(w, d)

const r2 = (v) => Math.round(v * 100) / 100

/**
 * Resolve final real-world size for a model.
 * bbox: { w, h, d } source bounding-box sizes in meters.
 * Returns { footprint: [w, d], height, mount }.
 */
export function sizeFor(id, _type, bbox) {
  const { w, h, d } = bbox
  let s = 1
  for (const [re, axis, target] of R) {
    if (re.test(id)) {
      const cur = axisValue(axis, w, h, d)
      if (cur > 1e-6) s = target / cur
      break
    }
  }
  // safety net for unmatched ids: keep source size within sane bounds
  const maxXZ = Math.max(w, d) * s
  if (maxXZ > 3) s *= 3 / maxXZ
  else if (maxXZ > 0 && maxXZ < 0.08) s *= 0.08 / maxXZ
  return {
    footprint: [r2(w * s), r2(d * s)],
    height: r2(h * s),
    mount: CEILING.test(id) ? 'ceiling' : 'floor',
  }
}
