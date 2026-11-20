// A small JSON file in the app's user data folder. No credentials ever go in here.
import {readFileSync, writeFileSync, renameSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

const DEFAULTS = {haptics: true, introDone: false, permissionSetup: {active: true, completed: false}};

export class Settings {
  constructor(file) {
    this.file = file;
    let saved = {};
    try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch {}
    this.values = this.#clean({...DEFAULTS, ...saved});
  }

  get() { return this.values; }

  update(patch) {
    this.values = this.#clean({...this.values, ...patch});
    mkdirSync(dirname(this.file), {recursive: true, mode: 0o700});
    writeFileSync(this.file + '.tmp', JSON.stringify(this.values, null, 2), {mode: 0o600});
    renameSync(this.file + '.tmp', this.file);
    return this.values;
  }

  #clean(values) {
    return {
      haptics: values.haptics !== false,
      // The three keys of the intro were pressed once (main.js); until then the row shows them after the permissions.
      introDone: values.introDone === true,
      permissionSetup: {active: values.permissionSetup?.active !== false, completed: values.permissionSetup?.completed === true},
    };
  }
}
