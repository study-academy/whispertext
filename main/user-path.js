// Apps started from Finder get a minimal PATH, so the person's own `claude` and `codex` would not be found.
// Their login shell knows the real one, but asking it takes seconds (6 s measured on a Mac with nvm) and used
// to block the whole start, and to be given up after 5 s, which lost the tools on exactly those Macs. Now the
// PATH of the last launch is used at once and the shell is asked in the background, with patience.
import {execFile} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, delimiter, dirname} from 'node:path';

const unique = parts => [...new Set(parts.filter(Boolean))].join(delimiter);

// The usual places first, then what the shell said last time, then what this process was given.
export function knownPath(cached = '', env = process.env, home = homedir()) {
  if (process.platform === 'win32') return env.PATH || '';
  return unique([join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', ...String(cached).split(delimiter), ...(env.PATH || '').split(delimiter)]);
}

export function readCachedPath(file) {
  try { const text = readFileSync(file, 'utf8').trim(); return text.length < 20_000 && !/[\r\n\0]/.test(text) ? text : ''; } catch { return ''; }
}

// Asks the login shell without blocking. Resolves to its PATH, or '' when it does not answer.
export function askShellPath({shell = process.env.SHELL || '/bin/zsh', timeoutMs = 20_000, run = execFile} = {}) {
  if (process.platform === 'win32') return Promise.resolve('');
  return new Promise(resolve => {
    try {
      run(shell, ['-ilc', 'printf "\\n__STUDYMUT_PATH__%s\\n" "$PATH"'], {encoding: 'utf8', timeout: timeoutMs}, (error, stdout) => {
        // The marker keeps whatever a profile prints at login out of the result.
        const found = String(stdout ?? '').match(/__STUDYMUT_PATH__(.*)/)?.[1]?.trim() ?? '';
        resolve(!error && found ? found : '');
      });
    } catch { resolve(''); }
  });
}

// Refreshes the PATH from the shell and remembers it. Resolves true when it changed what this process uses.
export async function refreshPath(file, options = {}) {
  const found = await askShellPath(options);
  if (!found) return false;
  try { mkdirSync(dirname(file), {recursive: true, mode: 0o700}); writeFileSync(file, found, {mode: 0o600}); } catch {}
  const next = knownPath(found);
  if (next === process.env.PATH) return false;
  process.env.PATH = next;
  return true;
}
