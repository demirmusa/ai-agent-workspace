import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ControlError } from './types.js';
import type { ControlStore } from './store.js';

const MAX_HISTORY = 5, MAX_BYTES = 100_000;
/** Project and script IDs as the settings create them; anything else would grow the database with arbitrary keys. */
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
type Entry = string | Record<string, string | boolean>;

/** Last run-script parameters per script, encrypted (AES-256-GCM) in the control database so they survive restarts and browser changes. */
export class RunScriptMemory {
  private key: Buffer | undefined;
  constructor(private readonly store: ControlStore) {}

  history(projectId: string, scriptId: string): Entry[] {
    const stored = this.store.getMeta(this.metaKey(projectId, scriptId));
    if (!stored) return [];
    try { return this.clean(JSON.parse(this.decrypt(stored))); } catch { return []; }
  }

  save(projectId: string, scriptId: string, history: unknown): Entry[] {
    const entries = this.clean(history);
    if (JSON.stringify(entries).length > MAX_BYTES) throw new ControlError('Script parameters are too large.');
    if (entries.length) this.store.setMeta(this.metaKey(projectId, scriptId), this.encrypt(JSON.stringify(entries)));
    else this.store.deleteMeta(this.metaKey(projectId, scriptId));
    return entries;
  }

  private metaKey(projectId: string, scriptId: string): string {
    if (!ID.test(projectId) || !ID.test(scriptId)) throw new ControlError('Invalid run script.', 404);
    return `run-script-args.${projectId}.${scriptId}`;
  }

  private clean(value: unknown): Entry[] {
    if (!Array.isArray(value)) throw new ControlError('Script parameter history must be a list.');
    const seen = new Set<string>();
    return value.filter((item): item is Entry => {
      if (typeof item !== 'string' && (!item || typeof item !== 'object' || Array.isArray(item) || Object.values(item).some((value) => typeof value !== 'string' && typeof value !== 'boolean'))) return false;
      const key = JSON.stringify(typeof item === 'string' ? item : Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, MAX_HISTORY);
  }

  private secret(): Buffer {
    if (this.key) return this.key;
    const path = join(this.store.directory, 'run-script-args.key');
    // 'wx' never replaces a key another request created a moment earlier; replacing it would make saved history unreadable.
    try { writeFileSync(path, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' }); try { chmodSync(path, 0o600); } catch { /* Best effort on Windows. */ } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return this.key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
  }

  private encrypt(text: string): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.secret(), iv);
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64')).join('.');
  }

  private decrypt(stored: string): string {
    const [iv, tag, data] = stored.split('.').map((part) => Buffer.from(part, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', this.secret(), iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(data!), decipher.final()]).toString('utf8');
  }
}
