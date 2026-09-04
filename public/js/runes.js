// Rune reference data lives in the SAME shared public.tarot_cards table
// color-tarot-app uses (card_type = '룬타로' vs '컬러타로') — see
// data/schema_migration_rune.sql for the column reuse/addition rationale.
// Aliases in SELECT map tarot_cards' column names back to the field names
// this app's pages use (name_en, keywords, upright, reversed, mantra).
import { getSb } from '/js/app.js';

const SELECT = [
  'id', 'name_ko', 'glyph', 'name_en:name', 'keywords:keyword', 'meaning',
  'deity', 'element', 'upright:advice', 'reversed:caution', 'remedy_magic',
  'talisman_material', 'talisman_engrave', 'talisman_carry', 'mantra:mood_quote',
].join(', ');

let cache = null;
let cachePromise = null;

// Fetched once per page load and memoized — every caller after the first
// gets the same in-memory array instantly.
export async function getRunes() {
  if (cache) return cache;
  if (!cachePromise) {
    cachePromise = (async () => {
      const sb = await getSb();
      const { data, error } = await sb
        .from('tarot_cards')
        .select(SELECT)
        .eq('card_type', '룬타로')
        .order('id');
      if (error) { cachePromise = null; throw error; }
      cache = data;
      return data;
    })();
  }
  return cachePromise;
}
