// Brings over what a person already has in Wispr Flow on this Mac: their words, corrections, snippets and the text of
// past dictations. Wispr Flow keeps them in a local SQLite file; it is opened read-only and never changed. Nothing is
// sent anywhere, and no account or token data is read (only the Dictionary and History tables, only the columns below).
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';

export const wisprFile = (home = homedir()) => join(home, 'Library', 'Application Support', 'Wispr Flow', 'flow.sqlite');

const clean = value => typeof value === 'string' ? value.trim() : '';

// Rows to whispertext's three kinds: a snippet (said by a short phrase), a correction (heard → written), a word.
export function sortDictionary(rows) {
  const words = [], rules = [], snippets = [];
  for (const row of rows) {
    if (row.isDeleted) continue;
    const phrase = clean(row.phrase), replacement = clean(row.replacement);
    if (!phrase) continue;
    if (row.isSnippet && replacement) snippets.push({trigger: phrase.slice(0, 80), value: replacement});
    else if (replacement && replacement !== phrase) rules.push({from: phrase.slice(0, 200), to: replacement.slice(0, 200)});
    else words.push(phrase.slice(0, 200));
  }
  return {words, rules, snippets};
}

export function sortHistory(rows) {
  return rows.map(row => {
    const final = clean(row.formattedText) || clean(row.asrText);
    const date = new Date(String(row.timestamp ?? '').replace(' +00:00', 'Z').replace(' ', 'T'));
    return final && !Number.isNaN(date.getTime()) ? {id: `wispr-${row.transcriptEntityId}`, createdAt: date.toISOString(), app: clean(row.app) || null, final} : null;
  }).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Reads Wispr Flow's file, if there is one. Returns null when Wispr Flow was never used here.
export async function readWispr(file = wisprFile()) {
  if (!existsSync(file)) return null;
  const {DatabaseSync} = await import('node:sqlite');
  // immutable: no lock and no journal of its own, so a running Wispr Flow is not disturbed.
  const url = pathToFileURL(file); url.search = 'immutable=1';
  const db = new DatabaseSync(url, {readOnly: true});
  try {
    const has = name => !!db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name);
    const dictionary = has('Dictionary') ? db.prepare('select phrase, replacement, isSnippet, isDeleted from Dictionary').all() : [];
    const history = has('History') ? db.prepare("select transcriptEntityId, formattedText, asrText, timestamp, app from History where coalesce(isArchived, 0) = 0").all() : [];
    return {...sortDictionary(dictionary), history: sortHistory(history)};
  } finally { db.close(); }
}

// Puts what was read into whispertext's store. Words the person already has stay as they are.
export function applyWispr(store, found) {
  let words = 0;
  for (const word of found.words) { try { store.addWord(word); words++; } catch {} }
  for (const rule of found.rules) { try { store.addRule(rule.from, rule.to, 'wispr'); words++; } catch {} }
  for (const snippet of found.snippets) { try { store.saveSnippet(snippet.trigger, snippet.value, null); words++; } catch {} }
  return {words, history: found.history.length};
}
