/**
 * Every plant in the built-in catalog (Gardyn's plant library and yCube store),
 * mapped to a plant archetype and its colours. A pod's free-text plant name is
 * matched to the closest entry by its words, so "Genovese Basil", "Cherry
 * Tomato" and "Red Russian Kale" find Basil, Red Cherry Tomatoes and Kale.
 */
import type { PlantStyle } from './kit'

export type Archetype
  = | 'rosette' | 'upright' | 'bokchoy' | 'strap' | 'cress'
    | 'herb-bush' | 'feathery' | 'woody'
    | 'fruiting-bush' | 'vine' | 'strawberry' | 'brassica-head'
    | 'flower' | 'spike' | 'sunflower'

export interface CatalogEntry { name: string, archetype: Archetype, style: PlantStyle }

const GREEN = { leaf: '#5bbf5f', leafDark: '#3a8f45' }
const LIGHT = { leaf: '#9ad86a', leafDark: '#6cb34e' }
const DARK = { leaf: '#3f8f4a', leafDark: '#2a6b37' }
const BLUE = { leaf: '#6f9f86', leafDark: '#4f7f69' }
const GREY = { leaf: '#8fae8a', leafDark: '#6f8f6c' }
const PURPLE = { leaf: '#6b3f6f', leafDark: '#4a2f55' }

const entry = (name: string, archetype: Archetype, style: PlantStyle): CatalogEntry => ({ name, archetype, style })

export const CATALOG: CatalogEntry[] = [
  // Greens
  entry('Arugula', 'upright', { ...DARK }),
  entry('Breen Lettuce', 'rosette', { leaf: '#8f3f4f', leafDark: '#5f8f3f', variant: 'romaine' }),
  entry('Buttercrunch', 'rosette', { ...LIGHT }),
  entry('Butterhead', 'rosette', { ...LIGHT }),
  entry('Endive Lettuce', 'rosette', { ...LIGHT, variant: 'endive' }),
  entry('Flashy Lettuce', 'rosette', { leaf: '#8fc95f', leafDark: '#9a4f4f', variant: 'romaine' }),
  entry('Green Salanova', 'rosette', { ...LIGHT, variant: 'frilly' }),
  entry('Iceberg Lettuce', 'rosette', { leaf: '#b5e08a', leafDark: '#7fbf5f', variant: 'head' }),
  entry('Muir Lettuce', 'rosette', { ...GREEN }),
  entry('Red Sails', 'rosette', { leaf: '#9a4a55', leafDark: '#7fa85a', variant: 'frilly' }),
  entry('Red Salad Bowl', 'rosette', { leaf: '#8a3f4a', leafDark: '#6b8f45', variant: 'frilly' }),
  entry('Romaine', 'rosette', { ...GREEN, variant: 'romaine' }),
  entry('Red Romaine', 'rosette', { leaf: '#8a3f4a', leafDark: '#5f8f3f', variant: 'romaine' }),
  entry('Red Oak Leaf Lettuce', 'rosette', { leaf: '#9a4a55', leafDark: '#6b8f45', variant: 'frilly' }),
  entry('Lollo Rossa', 'rosette', { leaf: '#9a3f4f', leafDark: '#6f8f45', variant: 'frilly' }),
  entry('Bronze Arrow', 'rosette', { leaf: '#8a5a3a', leafDark: '#6f8f3f', variant: 'romaine' }),
  entry('Cardinale', 'rosette', { leaf: '#7a3f4a', leafDark: '#5f8f3f', variant: 'romaine' }),
  entry('Monte Carlo', 'rosette', { ...GREEN }),
  entry('Rouge d\'Hiver', 'rosette', { leaf: '#8a4f4a', leafDark: '#5f8f3f', variant: 'romaine' }),
  entry('Green Cabbage', 'rosette', { ...BLUE, variant: 'head' }),
  entry('Radicchio', 'rosette', { leaf: '#8a2f45', leafDark: '#5f3f4f', variant: 'head' }),
  entry('Green Mustard', 'upright', { ...LIGHT }),
  entry('Red Mustard', 'upright', { leaf: '#7a3f55', leafDark: '#5f8f45' }),
  entry('American Mustard', 'upright', { ...LIGHT }),
  entry('Green Tatsoi', 'bokchoy', { ...DARK, variant: 'tatsoi' }),
  entry('Red Tatsoi', 'bokchoy', { leaf: '#6b3f55', leafDark: '#4f7f45', accent: '#c9d8b0', variant: 'tatsoi' }),
  entry('Tokyo Bekana', 'bokchoy', { ...LIGHT, accent: '#e6efcf' }),
  entry('Hon Tsai Tai', 'bokchoy', { ...GREEN, accent: '#e6efd0' }),
  entry('Collard Greens', 'upright', { ...BLUE, variant: 'curly' }),
  entry('Wasabi Greens', 'upright', { ...LIGHT }),
  entry('Green Bok Choy', 'bokchoy', { ...GREEN, accent: '#e6efd6' }),
  entry('Purple Bok Choy', 'bokchoy', { ...PURPLE, accent: '#d8e6c9' }),
  entry('Kale', 'upright', { ...BLUE, variant: 'curly' }),
  entry('Kale Lacinato', 'upright', { leaf: '#3f5f4f', leafDark: '#2f4a3f', variant: 'lacinato' }),
  entry('Perpetual Spinach', 'upright', { ...DARK }),
  entry('Red Sorrel', 'upright', { leaf: '#5f9f4f', leafDark: '#8a2f3f' }),
  entry('Sorrel', 'upright', { ...GREEN }),
  entry('Red Amaranth', 'upright', { leaf: '#9a2f4f', leafDark: '#6b2f45' }),
  entry('Red Swiss Chard', 'upright', { ...DARK, accent: '#c8323f', variant: 'chard' }),
  entry('Yellow Swiss Chard', 'upright', { ...DARK, accent: '#e8c93f', variant: 'chard' }),
  entry('Pink Swiss Chard', 'upright', { ...DARK, accent: '#e07aa0', variant: 'chard' }),
  entry('Celery', 'upright', { ...LIGHT, accent: '#b8d88f', variant: 'celery' }),
  entry('Pink Celery', 'upright', { ...LIGHT, accent: '#e8a0b8', variant: 'celery' }),
  entry('Bull\'s Blood Beets', 'upright', { leaf: '#6b2f45', leafDark: '#4a2a35' }),
  entry('Bunching Onions', 'strap', { leaf: '#5f9f6a', leafDark: '#3f7f4f', variant: 'onion' }),
  entry('Chives', 'strap', { ...DARK, accent: '#b48ad8' }),
  entry('Garlic Chives', 'strap', { ...DARK, accent: '#d8c84a' }),
  entry('Wheatgrass', 'strap', { leaf: '#7fcf4f', leafDark: '#5faf3f', variant: 'grass' }),
  entry('Lemongrass', 'strap', { leaf: '#b5d85a', leafDark: '#7faf3f', variant: 'grass' }),
  entry('Watercress', 'cress', { ...DARK }),
  entry('Purslane', 'cress', { leaf: '#6faf55', leafDark: '#4f8f3f' }),
  // Herbs
  entry('Basil', 'herb-bush', { ...GREEN }),
  entry('Holy Basil', 'herb-bush', { leaf: '#5f9f55', leafDark: '#6b3f5f' }),
  entry('Purple Basil', 'herb-bush', { ...PURPLE }),
  entry('Sweet Thai Basil', 'herb-bush', { ...DARK, accent: '#8a5fb4', variant: 'thai' }),
  entry('Lime Basil', 'herb-bush', { ...LIGHT, accent: '#c8d84a' }),
  entry('Mammoth Basil', 'herb-bush', { ...GREEN }),
  entry('Catnip', 'herb-bush', { ...GREY, variant: 'mint' }),
  entry('Mint', 'herb-bush', { ...GREEN, variant: 'mint' }),
  entry('Lemon Balm', 'herb-bush', { ...LIGHT, variant: 'mint' }),
  entry('Shiso', 'herb-bush', { leaf: '#3f7f4a', leafDark: '#6b3f55' }),
  entry('Oregano', 'herb-bush', { ...DARK, variant: 'oregano' }),
  entry('Sweet Marjoram', 'herb-bush', { ...GREY, variant: 'oregano' }),
  entry('Stevia', 'herb-bush', { ...GREEN, variant: 'stevia' }),
  entry('Dill', 'feathery', { leaf: '#6faf6a', leafDark: '#4f8f55' }),
  entry('Cilantro', 'feathery', { ...GREEN, variant: 'cilantro' }),
  entry('Italian Parsley', 'feathery', { ...DARK, variant: 'parsley' }),
  entry('Chervil', 'feathery', { ...LIGHT, variant: 'parsley' }),
  entry('Tarragon', 'feathery', { ...DARK, variant: 'tarragon' }),
  entry('Rosemary', 'woody', { leaf: '#4f7f5f', leafDark: '#5f4f3f' }),
  entry('Lavender', 'woody', { ...GREY, accent: '#8f6fc9', variant: 'lavender' }),
  entry('Thyme', 'woody', { leaf: '#5f8f5a', leafDark: '#5f4f3f', variant: 'thyme' }),
  entry('Savory', 'woody', { leaf: '#5f8f5a', leafDark: '#5f4f3f', variant: 'savory' }),
  entry('Sage', 'woody', { ...GREY, variant: 'sage' }),
  // Fruits and vegetables (the plainer of two close names first: it wins a tie)
  entry('Sweet Peppers', 'fruiting-bush', { ...DARK, accent: '#d8323a', accent2: '#5f9f3f', variant: 'pepper' }),
  entry('Banana Peppers', 'fruiting-bush', { ...DARK, accent: '#e8d24a', accent2: '#9fcf5f', variant: 'banana' }),
  entry('Black Pearl Pepper', 'fruiting-bush', { ...DARK, accent: '#2a1a2a', accent2: '#5f3f6f', variant: 'pepper' }),
  entry('Burrito Pepper', 'fruiting-bush', { ...DARK, accent: '#d87a2f', accent2: '#5f9f3f', variant: 'pepper' }),
  entry('Candy Cane Pepper', 'fruiting-bush', { ...DARK, accent: '#e0402f', accent2: '#f4f0e0', variant: 'pepper' }),
  entry('Goliath Pepper', 'fruiting-bush', { ...DARK, accent: '#d8323a', accent2: '#3f7f3f', variant: 'pepper' }),
  entry('Hungarian Hot Wax Pepper', 'fruiting-bush', { ...DARK, accent: '#e8d24a', accent2: '#d8323a', variant: 'pepper' }),
  entry('Lemon Hot Pepper', 'fruiting-bush', { ...DARK, accent: '#e8d24a', accent2: '#c8a020', variant: 'pepper' }),
  entry('Poblano Pepper', 'fruiting-bush', { ...DARK, accent: '#2f5f2f', accent2: '#3f7f3f', variant: 'pepper' }),
  entry('Purple Cayenne Pepper', 'fruiting-bush', { ...DARK, accent: '#6b2f6f', accent2: '#9a4f4f', variant: 'pepper' }),
  entry('Shishito Pepper', 'fruiting-bush', { ...DARK, accent: '#3f7f3f', accent2: '#8fbf4f', variant: 'pepper' }),
  entry('Cucumbers', 'vine', { ...GREEN, accent: '#3f7f3f', accent2: '#f0d040', variant: 'cucumber' }),
  entry('Green Beans', 'vine', { ...GREEN, accent: '#6faf3f', accent2: '#f0f0e0', variant: 'bean' }),
  entry('Dragon Beans', 'vine', { ...GREEN, accent: '#8a5fa8', accent2: '#e8dca0', variant: 'bean' }),
  entry('Purple Beans', 'vine', { ...GREEN, accent: '#6b3f8a', accent2: '#e8dca0', variant: 'bean' }),
  entry('Yellow Beans', 'vine', { ...GREEN, accent: '#e8d24a', accent2: '#f0f0e0', variant: 'bean' }),
  entry('Peas', 'vine', { ...LIGHT, accent: '#7fbf4f', accent2: '#f4f4ec', variant: 'pea' }),
  entry('Fairytale Eggplant', 'fruiting-bush', { ...GREY, accent: '#5f2f6f', accent2: '#c9a8e0', variant: 'eggplant' }),
  entry('Mini Eggplant', 'fruiting-bush', { ...GREY, accent: '#5f2f6f', accent2: '#c9a8e0', variant: 'eggplant' }),
  entry('Thai Eggplant', 'fruiting-bush', { ...GREY, accent: '#6b2f6f', accent2: '#d8b0e8', variant: 'eggplant' }),
  entry('Jalapeños', 'fruiting-bush', { ...DARK, accent: '#2f6f2f', accent2: '#c8323f', variant: 'jalapeno' }),
  entry('Red Cherry Tomatoes', 'fruiting-bush', { ...GREEN, accent: '#e0402f', accent2: '#8fbf4f', variant: 'cherry-tomato' }),
  entry('Yellow Cherry Tomato', 'fruiting-bush', { ...GREEN, accent: '#f0d040', accent2: '#8fbf4f', variant: 'cherry-tomato' }),
  entry('Bare Root Strawberries', 'strawberry', { ...GREEN, accent: '#d8323f', accent2: '#f4f0e0' }),
  entry('Red Mini Strawberries', 'strawberry', { ...GREEN, accent: '#d8323f', accent2: '#f4f0e0' }),
  entry('Yellow Mini Strawberry', 'strawberry', { ...GREEN, accent: '#f0d040', accent2: '#f4f0e0' }),
  entry('Cape Gooseberry', 'fruiting-bush', { ...GREEN, accent: '#e8c93f', accent2: '#8fbf4f' }),
  entry('Mini Okra', 'fruiting-bush', { ...GREEN, accent: '#5f9f3f', accent2: '#8fbf4f' }),
  entry('Mini Pumpkin', 'vine', { ...GREEN, accent: '#e07a20', accent2: '#f0d040' }),
  entry('Mini Squash', 'vine', { ...GREEN, accent: '#e8c93f', accent2: '#8fbf4f' }),
  entry('Mini Cauliflower', 'brassica-head', { ...BLUE, accent: '#f0ead6' }),
  entry('Mini Broccoli', 'brassica-head', { ...BLUE, accent: '#3f7f4a' }),
  entry('Purple Kohlrabi', 'brassica-head', { ...BLUE, accent: '#7a3f8a', variant: 'kohlrabi' }),
  entry('White Kohlrabi', 'brassica-head', { ...BLUE, accent: '#e8eedc', variant: 'kohlrabi' }),
  // Flowers
  entry('Dianthus', 'flower', { ...GREY, accent: '#e05a8a', accent2: '#f4c4d8', variant: 'dianthus' }),
  entry('Marigold', 'flower', { ...DARK, accent: '#f0902f', accent2: '#e8c03f', variant: 'marigold' }),
  entry('Purple Campanula', 'flower', { ...GREEN, accent: '#8a6fd8', accent2: '#c4b8f0', variant: 'campanula' }),
  entry('Purple Petunia', 'flower', { ...GREEN, accent: '#7a3fa8', accent2: '#f0e8f4', variant: 'petunia' }),
  entry('Pink Petunia', 'flower', { ...GREEN, accent: '#e07aa0', accent2: '#f4d8e4', variant: 'petunia' }),
  entry('White Petunia', 'flower', { ...GREEN, accent: '#f4f0e8', accent2: '#e8e0d0', variant: 'petunia' }),
  entry('Radio Calendula', 'flower', { ...GREEN, accent: '#f0a030', accent2: '#c86a20' }),
  entry('Oopsy Daisy', 'flower', { ...GREEN, accent: '#f0a030', accent2: '#e8c93f' }),
  entry('Torenia', 'flower', { ...GREEN, accent: '#6f4fc9', accent2: '#f0e8f4', variant: 'torenia' }),
  entry('Violet Impatiens', 'flower', { ...DARK, accent: '#9a4fc0', accent2: '#f0e0f4', variant: 'impatiens' }),
  entry('Red Impatiens', 'flower', { ...DARK, accent: '#d8323f', accent2: '#f0d0d0', variant: 'impatiens' }),
  entry('Purple Snapdragon', 'spike', { ...GREEN, accent: '#9a3f9a', accent2: '#f0d8f0' }),
  entry('Yellow Snapdragon', 'spike', { ...GREEN, accent: '#f0d040', accent2: '#f8f0c0' }),
  entry('Fuchsia Snapdragon', 'spike', { ...GREEN, accent: '#d0408a', accent2: '#f4c0d8' }),
  entry('Scarlet Snapdragon', 'spike', { ...GREEN, accent: '#d8323a', accent2: '#f4c0c0' }),
  entry('Stock Flower', 'spike', { ...GREY, accent: '#d8a0d8', accent2: '#f4e8f4', variant: 'stock' }),
  entry('Night-Scented Stock', 'spike', { ...GREY, accent: '#c8b0d8', accent2: '#f4e8f4', variant: 'stock' }),
  entry('Sunflower', 'sunflower', { ...GREEN, accent: '#f4c430', accent2: '#5f3a1f' }),
  entry('Bi-Color Sunflower', 'sunflower', { ...GREEN, accent: '#f4c430', accent2: '#8a3f2f' }),
  entry('Black Viola', 'flower', { ...DARK, accent: '#2a1a2a', accent2: '#6b4f8a' }),
  entry('Viola', 'flower', { ...GREEN, accent: '#8a6fd8', accent2: '#f0e8f4' }),
  entry('Blue Cornflower', 'flower', { ...GREEN, accent: '#4a6fd8', accent2: '#c4d0f0' }),
  entry('Blush Hibiscus', 'flower', { ...GREEN, accent: '#e07aa0', accent2: '#f4d8e4' }),
  entry('Red Hibiscus', 'flower', { ...GREEN, accent: '#d8323a', accent2: '#f4c0c0' }),
  entry('Borage', 'flower', { ...GREEN, accent: '#5a7fd8', accent2: '#c4d0f0' }),
  entry('Canna Flower', 'flower', { ...GREEN, accent: '#e0402f', accent2: '#f0d040' }),
  entry('Celosia Mix', 'flower', { ...GREEN, accent: '#d8326f', accent2: '#f0a030' }),
  entry('Chamomile', 'flower', { ...GREEN, accent: '#f4e080', accent2: '#f8f0c0' }),
  entry('Fiesta Gitana', 'flower', { ...GREEN, accent: '#e07a20', accent2: '#f0d040' }),
  entry('Matilda', 'flower', { ...GREEN, accent: '#e05a8a', accent2: '#f4c4d8' }),
  entry('Nasturtium', 'flower', { ...GREEN, accent: '#e07a20', accent2: '#f0d040' }),
  entry('Portulaca Mix', 'flower', { ...GREEN, accent: '#e05a8a', accent2: '#f0a030' }),
  entry('Zinnia', 'flower', { ...GREEN, accent: '#e0402f', accent2: '#f0d040' }),
]

/** Words that narrow a match (a colour, "sweet") without naming the plant. */
const QUALIFIERS = new Set(['red', 'green', 'purple', 'yellow', 'violet', 'sweet', 'mini', 'italian', 'perpetual', 'holy', 'radio', 'lettuce', 'flower', 'lime', 'mammoth', 'pink', 'bronze', 'blush', 'white', 'black', 'blue', 'american', 'cape', 'bare', 'root'])

/** Lower case, no accents, singular: "Jalapeños" → ["jalapeno"], "Red Cherry Tomatoes" → ["red", "cherry", "tomato"], "Strawberries" → ["strawberry"]. */
export function words(name: string): string[] {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z]+/).filter(Boolean)
    .map(w => (w.endsWith('oes') ? w.slice(0, -2) : w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
}

/**
 * A matcher from a pod's plant name to the closest of `entries`, or null when
 * nothing matches. Words that name the plant score 1, qualifiers 0.3, and each
 * entry word the name lacks costs 0.1, so "Kale" beats "Kale Lacinato" for
 * "Red Russian Kale".
 */
export function nameMatcher<E extends { name: string }>(entries: E[]): (plant: string | null | undefined) => E | null {
  const index = entries.map(e => ({ e, words: words(e.name) }))
  return (plant) => {
    if (!plant) return null
    const have = new Set(words(plant))
    let best: { e: E, score: number } | null = null
    for (const { e, words: ws } of index) {
      let named = 0
      let score = 0
      for (const w of ws) {
        if (have.has(w)) {
          const q = QUALIFIERS.has(w)
          score += q ? 0.3 : 1
          if (!q) named++
        }
        else score -= 0.1
      }
      if (named > 0 && (!best || score > best.score)) best = { e, score }
    }
    return best?.e ?? null
  }
}

/** The catalog entry for a pod's plant name, or null when nothing matches. */
export const lookup = nameMatcher(CATALOG)

/** What an unrecognised plant looks like: a generic leafy rosette. */
export const FALLBACK: CatalogEntry = entry('Unknown', 'rosette', { ...GREEN })
