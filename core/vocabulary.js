// Technical terms the recogniser nearly got: "Citratsyklus", "Rotatorenmannskette", "Kitra-Zyklus". A word that
// sounds like a known term and is spelled almost like it becomes that term. The known terms are the person's own
// dictionary, the words around the cursor, and a starter list for study subjects. Local, instant, and careful:
// short words and anything not clearly close stay as heard.

// How a word sounds, roughly, in German: so c/k, z/ts, ph/f, y/i and doubled letters do not count as differences.
export function soundKey(word) {
  return String(word).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, m => m === '̈' ? 'e' : '')
    .replace(/ß/g, 'ss').replace(/[^a-z]/g, '').replace(/sch/g, 'S').replace(/ph/g, 'f').replace(/th/g, 't').replace(/ck/g, 'k').replace(/qu/g, 'kw')
    .replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/tz|ts|z/g, 's').replace(/y/g, 'i').replace(/v/g, 'f').replace(/ie/g, 'i').replace(/(.)\1+/g, '$1');
}

function distance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let row = Array.from({length: b.length + 1}, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) { next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (next[j] < best) best = next[j]; }
    if (best > limit) return limit + 1;
    row = next;
  }
  return row[b.length];
}

// The team's list (Studyacademy, Neurobites, aureliohealth, content about learning and the brain): names, products
// and the English and Denglisch words the team says in scripts, which recognisers write the German way. The person's
// own dictionary always comes first. Only terms of seven or more sounds are corrected locally; all of them help the
// optional tidying with Claude. Collected 20.11.2026 from study-academy.de, tryneurobites.com and Henry's profile.
export const TEAM_TERMS = [
  // Names, brands, products
  'Studyacademy', 'Study Academy', 'Studymut', 'Neurobites', 'Lernphysio', 'aureliohealth', 'Henry Hildebrandt', 'Hildebrandt',
  'Inner Circle', 'Lernsystem Neuro', 'Lernsystem Pro', 'Last-Minute-Lernplan', 'Brainhacks', 'Flowmaps', 'Flowmap', 'RemNote', 'Notion',
  'Anki', 'Circle', 'Linktree', 'TEDx', 'TEDx Speaker', 'SPIEGEL-Bestseller', 'Neuroscience', 'Neuroscience Creator', 'Focus & Energy Gum',
  'Energy Gum', 'Refill Case', 'Refill Jar', 'Fokus-Journal', 'Starterpaket', 'Scientific Advisory Board', 'Bella Mishuris', 'Maximilian Hahne',
  'Manuela Adcock', 'Lucia Rohfleisch', 'Maastricht University',
  // Supplements and ingredients
  'Supplement', 'Supplements', 'Nootropics', 'Guarana', 'Guaranasamenextrakt', 'Ginseng', 'Ginsengextrakt', 'Koffein', 'Pantothensäure',
  'Vitamin B5', 'Vitamin B6', 'Mikronährstoffe', 'Energiestoffwechsel', 'Birkenharz', 'Zuckerfrei',
  // Brain, focus, learning
  'Neurowissenschaft', 'Neurowissenschaftler', 'Neuropsychologin', 'Neuroplastizität', 'Dopamin', 'Serotonin', 'Melatonin',
  'Adenosin', 'Noradrenalin', 'Präfrontaler Kortex', 'Hippocampus', 'Amygdala', 'ADHS', 'Brain Fog', 'Flow State', 'Deep Work',
  'Growth Mindset', 'Mindset', 'Prokrastination', 'Prüfungsangst', 'Prüfungsphase', 'Klausurenphase', 'Altklausuren', 'Selbstwirksamkeit',
  'Metakognition', 'Konzentration', 'Spaced Repetition', 'Active Recall', 'Retrieval Practice', 'Retrieval', 'Interleaving',
  'Feynman-Technik', 'Pomodoro', 'Priming', 'Encoding', 'Konsolidierung', 'Vergessenskurve', 'Gedächtnisspur', 'Abrufprotokoll',
  'Mastery', 'Mindmap', 'Karteikarten', 'Probeklausur', 'Staatsexamen', 'Physikum', 'Bachelorarbeit', 'Hausarbeit',
  // Content and work
  'Hook', 'Call to Action', 'Reel', 'Reels', 'Shorts', 'Thumbnail', 'Voice Over', 'B-Roll', 'Retention', 'Engagement', 'Storytelling',
  'Copywriting', 'Creator', 'Community', 'Newsletter', 'Landingpage', 'Funnel', 'Webinar', 'Onboarding',
  'Instagram', 'YouTube', 'TikTok', 'LinkedIn', 'Black Friday', 'Morning Routine', 'Coaching',
];
// Kept under its old name for the Studymut tests that came along.
export const STUDY_TERMS = TEAM_TERMS;

// Studymut's own names are said in every other dictation and heard as English words ("Study Mood", "Study-Mode",
// "Studi Mut", "Study-Mods kleines Zuhause"). These spellings are always the name; a trailing s stays ("Studymuts").
const OWN_NAMES = [
  [/(?<![\p{L}\p{N}])stud(?:y|i|ie)[\s-]?(?:mood|mode|mod|mut|moot|mud|mutt|mott|mot|mate|mount)(s?)(?![\p{L}\p{N}])/giu, 'Studymut'],
  // Heard on 15.11.2026: "Sally Mut", "Stalin Mut", "Starry Mut". Only with "Mut" behind; the first word alone stays.
  // The same by sound, for the spellings nobody listed: "Stunny Mood", "Studdy Mond", "Sturdy Mut" (17.11.2026).
  [/(?<![\p{L}\p{N}])st[aeuoäü]{1,2}[dnlrt]{1,2}(?:y|i|ie|ey)[\s-]?m(?:oo|ou|oh|uh|o|u)(?:nd|nt|dt|tt|dd|de|te|d|t|n)(s?)(?![\p{L}\p{N}])/giu, 'Studymut'],
  [/(?<![\p{L}\p{N}])(?:sally|salli|stalin|staly|stady|steady|stedi|starry|starri|stary)[\s-]?mut(s?)(?![\p{L}\p{N}])/giu, 'Studymut'],
  [/(?<![\p{L}\p{N}])stud(?:y|i|ie)[\s-](?:academy|akademie|academie)(s?)(?![\p{L}\p{N}])/giu, 'Studyacademy'],
  [/(?<![\p{L}\p{N}])lern[\s-](?:physio|füsio|fisio)(s?)(?![\p{L}\p{N}])/giu, 'Lernphysio'],
  // "Neuro Bites", "Neurobytes", "Neuro-Beits": the gum's name.
  [/(?<![\p{L}\p{N}])neuro[\s-]?(?:bites|bytes|beits|baits|bights|bitz|bits|beitz)()(?![\p{L}\p{N}])/giu, 'Neurobites'],
  // Heard on 20.11.2026 from the team bench: "Themnail", "Floßdelit", "Floßdate", "aktiv Recall".
  [/(?<![\p{L}\p{N}])(?:them|tham|thum|tum|thumb|tham)[\s-]?n[ae]i?ls?()(?![\p{L}\p{N}])/giu, 'Thumbnail'],
  [/(?<![\p{L}\p{N}])flo(?:w|ß|ss|s)[\s-]?(?:state|steit|stejt|stayt|delit|date|deit|steht)()(?![\p{L}\p{N}])/giu, 'Flow State'],
  [/(?<![\p{L}\p{N}])aktiv[\s-]?re(?:call|kol|kall|col|koll)()(?![\p{L}\p{N}])/giu, 'Active Recall'],
  [/(?<![\p{L}\p{N}])aurelio[\s-]?health()(?![\p{L}\p{N}])/giu, 'aureliohealth'],
  [/(?<![\p{L}\p{N}])(?:ted|tet|tedd)[\s-]?(?:x|ex|ix)()(?![\p{L}\p{N}])/giu, 'TEDx'],
];
export const ownNames = (text = '') => OWN_NAMES.reduce((result, [heard, name]) => result.replace(heard, (all, plural) => name + (plural ? 's' : '')), String(text));

// Units the recogniser shortens into a different unit: "3,5 mm pro Liter" was "Millimol" (20.11.2026); a length
// per volume means nothing, so the amount of substance is meant.
const UNITS = [[/(?<=\d)\s*mm(?=\s+pro\s+(?:Liter|Deziliter)(?![\p{L}]))/gu, ' Millimol']];
const units = text => UNITS.reduce((result, [heard, unit]) => result.replace(heard, unit), text);

// The consonants of a word as it sounds: vowels are what recognisers most often hear differently in English terms
// ("Aktivrekol" for "Active Recall", 20.11.2026).
const skeleton = key => key[0] + key.slice(1).replace(/[aeiou]/g, '');

// The words of a text that are long enough to be terms (what stands around the cursor is likely to be said again).
export const termsIn = (text = '') => [...new Set(String(text).match(/[\p{L}][\p{L}-]{7,}/gu) ?? [])];

// Returns the text with near misses of known terms corrected. One or two heard words (also joined by a hyphen
// or split by a blank) may make one term; a term of two words may have been heard as one.
export function vocabularyFix(text = '', terms = []) {
  text = units(ownNames(text));
  const known = new Map();
  for (const term of terms) {
    const key = soundKey(term);
    if (key.length < 7) continue;
    if (!known.has(key)) known.set(key, term);
    // A term written with C is heard with a K or an S sound, depending on who speaks ("Citrat", "Kitrat").
    if (/^c/i.test(term)) for (const first of ['k', 's']) { const other = first + key.slice(1); if (!known.has(other)) known.set(other, term); }
  }
  if (!known.size) return text;
  // The same consonants in the same order, at least five, belonging to exactly one term.
  const bones = new Map();
  for (const [key, term] of known) { const bone = skeleton(key); if (bone.length < 6) continue; bones.set(bone, bones.has(bone) && bones.get(bone) !== term ? null : term); }
  const exact = new Set([...known.values()].flatMap(term => term.toLowerCase().split(/\s+/)));
  const closest = heard => {
    const key = soundKey(heard);
    if (key.length < 7) return null;
    if (known.has(key)) return known.get(key);
    const bone = skeleton(key);
    if (bone.length >= 6 && bones.get(bone)) return bones.get(bone);
    // One slip per six sounds, at most three; the first sound must match (it is almost always heard right).
    const limit = Math.min(3, Math.floor(key.length / 6));
    let best = null, bestDistance = limit + 1, tie = false;
    for (const [candidate, term] of known) {
      if (candidate[0] !== key[0]) continue;
      const d = distance(key, candidate, limit);
      if (d < bestDistance) { best = term; bestDistance = d; tie = false; } else if (d === bestDistance && term !== best) tie = true;
    }
    return best && !tie ? best : null;
  };
  // Tokens with what stands between them, so everything else in the text stays exactly as it is.
  const pieces = String(text).split(/([\p{L}][\p{L}'’]*)/u);
  for (let i = 1; i < pieces.length; i += 2) {
    const word = pieces[i];
    if (exact.has(word.toLowerCase())) continue;
    // The word alone first: if it is a near miss of a term, the word after it has nothing to do with it.
    const term = closest(word);
    // A word built on a term ("Biomechaniker", "Mitochondriums") is its own word.
    if (term && word.toLowerCase().startsWith(term.toLowerCase())) continue;
    if (term) { if (term.toLowerCase() !== word.toLowerCase()) pieces[i] = term; continue; }
    // Two heard words that are one term ("Kitra-Zyklus", "Aktiv Recall"): only real words on both sides, never a
    // little word like "im" or "der" that merely stands next to a term.
    const gap = pieces[i + 1], next = pieces[i + 2];
    if (next && /^[- ]$/.test(gap ?? '') && word.length >= 3 && next.length >= 4 && !exact.has(next.toLowerCase())) {
      const joined = closest(word + next);
      if (joined && soundKey(word + next).length >= 9) { pieces[i] = joined; pieces[i + 1] = ''; pieces[i + 2] = ''; i += 2; }
    }
  }
  return pieces.join('');
}

// The terms worth knowing from the names of a learner's subjects and topics: whole names of up to three words
// ("Manuelle Therapie") and every long word in them ("Rotatorenmanschette"). At most 600.
export function termsFromTitles(titles = []) {
  const terms = new Set();
  for (const raw of titles) {
    const title = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!title || title.length > 80) continue;
    const parts = title.split(' ');
    if (parts.length <= 3 && title.length >= 7) terms.add(title);
    for (const word of title.match(/[\p{L}][\p{L}-]{7,}/gu) ?? []) terms.add(word);
    if (terms.size >= 600) break;
  }
  return [...terms];
}
