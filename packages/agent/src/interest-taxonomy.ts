/**
 * Structured interest-tag taxonomy for V0.1 matching.
 *
 * Free-text interests stay free-text in the profile. This module only
 * provides:
 *   1. Canonical ids + aliases (so "AI" / "人工智能" / "ml" overlap)
 *   2. Categories for the Create-Agent suggestion chips
 *
 * Matching still uses Jaccard over tokens; aliases are normalised
 * before the set comparison so localisation does not hide overlap.
 */

export type InterestCategoryId =
  | 'tech'
  | 'creative'
  | 'outdoors'
  | 'games'
  | 'learning'
  | 'social';

export interface InterestTag {
  /** Stable id used after normalisation (lowercase snake-ish). */
  readonly id: string;
  readonly category: InterestCategoryId;
  /** Display labels / aliases that map to this id (any locale). */
  readonly aliases: readonly string[];
}

export const INTEREST_TAXONOMY: readonly InterestTag[] = Object.freeze([
  {
    id: 'ai',
    category: 'tech',
    aliases: ['ai', 'artificial intelligence', '人工智能', '机器学习', 'ml', 'machine learning', 'llm'],
  },
  {
    id: 'programming',
    category: 'tech',
    aliases: ['programming', 'coding', '编程', '开发', 'software', 'typescript', 'rust', 'python'],
  },
  {
    id: 'open_source',
    category: 'tech',
    aliases: ['open source', 'opensource', '开源', 'foss'],
  },
  {
    id: 'indie_hacking',
    category: 'tech',
    aliases: ['indie hacking', 'indiehack', '独立开发', 'side project', 'bootstrapping'],
  },
  {
    id: 'music',
    category: 'creative',
    aliases: ['music', '音乐', 'guitar', 'piano', '作曲'],
  },
  {
    id: 'writing',
    category: 'creative',
    aliases: ['writing', '写作', 'blogging', 'journalism'],
  },
  {
    id: 'design',
    category: 'creative',
    aliases: ['design', '设计', 'ui', 'ux', 'figma'],
  },
  {
    id: 'climbing',
    category: 'outdoors',
    aliases: ['climbing', '攀岩', 'bouldering', '岩壁'],
  },
  {
    id: 'hiking',
    category: 'outdoors',
    aliases: ['hiking', '徒步', 'hiking trails', '登山'],
  },
  {
    id: 'fpv',
    category: 'outdoors',
    aliases: ['fpv', 'fpv 飞行', 'drone', '无人机'],
  },
  {
    id: 'gaming',
    category: 'games',
    aliases: ['gaming', '游戏', 'video games', 'pc gaming', '主机游戏'],
  },
  {
    id: 'board_games',
    category: 'games',
    aliases: ['board games', '桌游', 'tabletop'],
  },
  {
    id: 'reading',
    category: 'learning',
    aliases: ['reading', '阅读', 'books', '读书'],
  },
  {
    id: 'languages',
    category: 'learning',
    aliases: ['languages', '语言学习', 'language learning', '日语', '英语'],
  },
  {
    id: 'coffee',
    category: 'social',
    aliases: ['coffee', '咖啡', 'cafe', '手冲'],
  },
  {
    id: 'cooking',
    category: 'social',
    aliases: ['cooking', '做饭', 'cooking at home', '烘焙'],
  },
]);

const ALIAS_TO_ID: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const tag of INTEREST_TAXONOMY) {
    map.set(tag.id, tag.id);
    for (const alias of tag.aliases) {
      map.set(alias.trim().toLowerCase(), tag.id);
    }
  }
  return map;
})();

/** Normalise a free-text interest to a canonical id when known. */
export function normaliseInterestToken(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (!t) return '';
  return ALIAS_TO_ID.get(t) ?? t;
}

/** Expand a set of interests into canonical tokens for overlap. */
export function canonicalInterestSet(items: readonly string[] | undefined): Set<string> {
  const out = new Set<string>();
  if (!items) return out;
  for (const raw of items) {
    const id = normaliseInterestToken(raw);
    if (id) out.add(id);
  }
  return out;
}

/**
 * For UI / commonGround: prefer the caller's own wording for each shared
 * canonical id (so a Chinese profile keeps 「人工智能」 instead of `ai`).
 */
export function displayLabelsForSharedInterests(
  preferred: readonly string[] | undefined,
  sharedCanonical: readonly string[],
): string[] {
  const shared = new Set(sharedCanonical);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of preferred ?? []) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const id = normaliseInterestToken(trimmed);
    if (!shared.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(trimmed);
  }
  if (out.length > 0) return out;
  return sharedCanonical.filter(Boolean);
}

export function interestsInCategory(category: InterestCategoryId): readonly InterestTag[] {
  return INTEREST_TAXONOMY.filter((t) => t.category === category);
}

export const INTEREST_CATEGORY_ORDER: readonly InterestCategoryId[] = [
  'tech',
  'creative',
  'outdoors',
  'games',
  'learning',
  'social',
];
