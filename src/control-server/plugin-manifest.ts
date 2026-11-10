import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { ControlError } from './types.js';
import { jsonObject } from './validation.js';

/** plugin.json: limits, validation and reading, plus the per-task plugin data. Docs: src/assets/agent-skills/aiws-plugin-development. */
export const PLUGIN_API_VERSION = 1;
export const PLUGIN_LIMITS = { files: 1_000, fileBytes: 10 * 1024 * 1024, totalBytes: 50 * 1024 * 1024, storageBytes: 1024 * 1024, settingsBytes: 256 * 1024, taskDataBytes: 64 * 1024, themes: 20, styles: 20, settings: 50, logs: 200 };
export const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/;
/** A base64 ZIP of the largest allowed plugin, with room for the JSON around it. */
export const PLUGIN_INSTALL_BODY_BYTES = Math.ceil(PLUGIN_LIMITS.totalBytes * 1.6);
// Windows cannot create these names (CON, NUL, COM1...), nor names ending in a dot or space.
const RESERVED_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$|[. ]$/i;
const SETTING_TYPES = ['text', 'textarea', 'password', 'number', 'boolean', 'select', 'color'] as const;
type SettingType = typeof SETTING_TYPES[number];
/** Plain text or one text per interface language, such as { "tr": "Merhaba", "en": "Hello" }. */
export type PluginText = string | Record<string, string>;
export interface PluginSettingField { key: string; type: SettingType; label: PluginText; description?: PluginText; placeholder?: PluginText; default?: string | number | boolean; options?: { value: string; label: PluginText }[]; min?: number; max?: number }
export interface PluginTheme { id: string; name: PluginText; description?: PluginText; dark?: Record<string, string>; light?: Record<string, string>; css?: string }
export interface PluginManifest {
  id: string; name: PluginText; version: string; description?: PluginText; author?: string; homepage?: string; apiVersion: number;
  icon?: string; main?: string; styles: string[]; server?: string; themes: PluginTheme[]; settings: PluginSettingField[];
}

/** Throws the ControlError every plugin check reports. */
export const fail = (message: string, status = 400): never => { throw new ControlError(message, status); };
function localized(value: unknown, name: string, max: number, required = false): PluginText | undefined {
  if (value === undefined || value === null) { if (required) fail(`${name} is required.`); return undefined; }
  if (typeof value === 'string') { if (value.length > max || (required && !value.trim())) fail(`${name} must be text, at most ${max} characters.`); return value; }
  const entries = Object.entries(jsonObject(value, name));
  if (!entries.length || entries.length > 20 || entries.some(([language, text]) => !/^[a-z]{2}(-[A-Z]{2})?$/.test(language) || typeof text !== 'string' || text.length > max)) fail(`${name} must be text or an object of language codes to text.`);
  return Object.fromEntries(entries) as Record<string, string>;
}
/** A file path inside the plugin folder, written with forward slashes and no parent segments. */
export function pluginRelativePath(value: unknown, name: string, extensions?: string[]): string {
  if (typeof value !== 'string' || !value || value.length > 300) return fail(`${name} must be a relative file path.`);
  const path = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (isAbsolute(path) || path.startsWith('/') || path.split('/').some((part) => !part || part === '..' || part === '.' || RESERVED_NAME.test(part)) || /[\0:*?"<>|]/.test(path)) fail(`${name} must stay inside the plugin folder: ${value}`);
  if (extensions && !extensions.some((extension) => path.toLowerCase().endsWith(extension))) fail(`${name} must end with ${extensions.join(' or ')}.`);
  return path;
}
function themeTokens(value: unknown, name: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const entries = Object.entries(jsonObject(value, name));
  if (entries.length > 400) fail(`${name} has more than 400 tokens.`);
  return Object.fromEntries(entries.map(([key, token]) => {
    const property = key.replace(/^--/, '');
    if (!/^[a-z][a-z0-9-]{0,80}$/.test(property)) fail(`${name}.${key} is not a valid CSS custom property name.`);
    if (typeof token !== 'string' || !token.trim() || token.length > 400 || /[;{}<>]/.test(token)) fail(`${name}.${key} must be a CSS value without ; { } < >.`);
    return [property, (token as string).trim()];
  }));
}
export function validatePluginManifest(input: unknown): PluginManifest {
  const value = jsonObject(input, 'plugin.json');
  const id = value.id; if (typeof id !== 'string' || !PLUGIN_ID.test(id)) fail('plugin.json id must be 3-64 lowercase letters, digits, dots, dashes or underscores, such as "acme.task-stats".');
  const version = value.version; if (typeof version !== 'string' || !/^[0-9A-Za-z.+-]{1,40}$/.test(version)) fail('plugin.json version must be a version such as "1.0.0".');
  const apiVersion = value.apiVersion ?? PLUGIN_API_VERSION;
  if (!Number.isInteger(apiVersion) || Number(apiVersion) < 1) fail('plugin.json apiVersion must be a positive integer.');
  if (Number(apiVersion) > PLUGIN_API_VERSION) fail(`This plugin needs plugin API ${String(apiVersion)}; this AIWS supports API ${PLUGIN_API_VERSION}. Update AIWS.`);
  const homepage = value.homepage; if (homepage !== undefined && (typeof homepage !== 'string' || !/^https?:\/\//.test(homepage) || homepage.length > 500)) fail('plugin.json homepage must be an http(s) URL.');
  const author = value.author; if (author !== undefined && (typeof author !== 'string' || author.length > 200)) fail('plugin.json author must be text.');
  const styles = value.styles ?? []; if (!Array.isArray(styles) || styles.length > PLUGIN_LIMITS.styles) fail(`plugin.json styles must be at most ${PLUGIN_LIMITS.styles} CSS files.`);
  const themes = value.themes ?? []; if (!Array.isArray(themes) || themes.length > PLUGIN_LIMITS.themes) fail(`plugin.json themes must be at most ${PLUGIN_LIMITS.themes} themes.`);
  const settings = value.settings ?? []; if (!Array.isArray(settings) || settings.length > PLUGIN_LIMITS.settings) fail(`plugin.json settings must be at most ${PLUGIN_LIMITS.settings} fields.`);
  const themeIds = new Set<string>(); const settingKeys = new Set<string>();
  const manifest: PluginManifest = {
    id: id as string, name: localized(value.name, 'plugin.json name', 80, true)!, version: version as string, apiVersion: Number(apiVersion),
    styles: (styles as unknown[]).map((style, index) => pluginRelativePath(style, `styles[${index}]`, ['.css'])),
    themes: (themes as unknown[]).map((raw, index) => {
      const theme = jsonObject(raw, `themes[${index}]`); const themeId = theme.id;
      if (typeof themeId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(themeId) || themeIds.has(themeId)) fail(`themes[${index}].id must be a unique lowercase id.`);
      themeIds.add(themeId as string);
      const dark = themeTokens(theme.dark, `themes[${index}].dark`), light = themeTokens(theme.light, `themes[${index}].light`), css = theme.css === undefined ? undefined : pluginRelativePath(theme.css, `themes[${index}].css`, ['.css']);
      if (!dark && !light && !css) fail(`themes[${index}] needs dark or light tokens or a css file.`);
      const description = localized(theme.description, `themes[${index}].description`, 300);
      return { id: themeId as string, name: localized(theme.name, `themes[${index}].name`, 80, true)!, ...(description ? { description } : {}), ...(dark ? { dark } : {}), ...(light ? { light } : {}), ...(css ? { css } : {}) };
    }),
    settings: (settings as unknown[]).map((raw, index) => {
      const field = jsonObject(raw, `settings[${index}]`), key = field.key, type = field.type ?? 'text';
      if (typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) || settingKeys.has(key)) fail(`settings[${index}].key must be a unique name such as "apiUrl".`);
      settingKeys.add(key as string);
      if (!SETTING_TYPES.includes(type as SettingType)) fail(`settings[${index}].type must be one of ${SETTING_TYPES.join(', ')}.`);
      const options = field.options === undefined ? undefined : (Array.isArray(field.options) && field.options.length <= 100 ? field.options : fail(`settings[${index}].options must be at most 100 choices.`)).map((option: unknown, at: number) => {
        const choice = jsonObject(option, `settings[${index}].options[${at}]`); if (typeof choice.value !== 'string' || choice.value.length > 200) fail(`settings[${index}].options[${at}].value must be text.`);
        return { value: choice.value as string, label: localized(choice.label ?? choice.value, `settings[${index}].options[${at}].label`, 120, true)! };
      });
      if (type === 'select' && !options?.length) fail(`settings[${index}] is a select and needs options.`);
      for (const bound of ['min', 'max'] as const) if (field[bound] !== undefined && typeof field[bound] !== 'number') fail(`settings[${index}].${bound} must be a number.`);
      const result: PluginSettingField = { key: key as string, type: type as SettingType, label: localized(field.label ?? key, `settings[${index}].label`, 120, true)! };
      const description = localized(field.description, `settings[${index}].description`, 500), placeholder = localized(field.placeholder, `settings[${index}].placeholder`, 200);
      if (description) result.description = description; if (placeholder) result.placeholder = placeholder; if (options) result.options = options;
      if (typeof field.min === 'number') result.min = field.min; if (typeof field.max === 'number') result.max = field.max;
      if (field.default !== undefined) result.default = settingValue(result, field.default);
      return result;
    }),
  };
  const description = localized(value.description, 'plugin.json description', 1_000);
  if (description) manifest.description = description; if (author) manifest.author = author as string; if (homepage) manifest.homepage = homepage as string;
  if (value.icon !== undefined) manifest.icon = pluginRelativePath(value.icon, 'icon', ['.svg', '.png', '.webp', '.jpg', '.jpeg']);
  if (value.main !== undefined) manifest.main = pluginRelativePath(value.main, 'main', ['.js', '.mjs']);
  if (value.server !== undefined) manifest.server = pluginRelativePath(value.server, 'server', ['.js', '.mjs']);
  return manifest;
}
/** A setting value checked against its manifest field. */
export function settingValue(field: PluginSettingField, value: unknown): string | number | boolean {
  if (field.type === 'boolean') return typeof value === 'boolean' ? value : fail(`${field.key} must be true or false.`);
  if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${field.key} must be a number.`);
    if (field.min !== undefined && (value as number) < field.min || field.max !== undefined && (value as number) > field.max) fail(`${field.key} must be between ${field.min ?? '-∞'} and ${field.max ?? '∞'}.`);
    return value as number;
  }
  if (typeof value !== 'string' || value.length > 100_000) return fail(`${field.key} must be text.`);
  if (field.type === 'select' && !field.options?.some((option) => option.value === value)) fail(`${field.key} must be one of ${field.options?.map((option) => option.value).join(', ')}.`);
  if (field.type === 'color' && value && !/^#[0-9a-fA-F]{3,8}$/.test(value)) fail(`${field.key} must be a hex color such as #3366ff.`);
  return value;
}
/** Per-plugin task data: { pluginId: object | null }. A null value removes that plugin's data; other plugins' data is kept. */
export function mergeTaskPluginData(previous: Record<string, Record<string, unknown>> | undefined, input: unknown): Record<string, Record<string, unknown>> | undefined {
  const result = { ...(previous ?? {}) };
  for (const [pluginId, value] of Object.entries(jsonObject(input, 'pluginData'))) {
    if (!PLUGIN_ID.test(pluginId)) fail(`pluginData key ${pluginId} is not a plugin id.`);
    if (value === null) { delete result[pluginId]; continue; }
    result[pluginId] = structuredClone(jsonObject(value, `pluginData.${pluginId}`));
  }
  if (Buffer.byteLength(JSON.stringify(result)) > PLUGIN_LIMITS.taskDataBytes) fail(`Task plugin data must be at most ${PLUGIN_LIMITS.taskDataBytes / 1024} KiB.`);
  return Object.keys(result).length ? result : undefined;
}
/** The validated manifest of plugin.json; `read` returns its text or throws the read error. */
function parseManifest(read: () => string): PluginManifest {
  let raw: unknown;
  try { raw = JSON.parse(read().replace(/^﻿/, '')); }
  catch (error) { return fail((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'plugin.json was not found in the plugin folder.' : `plugin.json is not valid JSON: ${(error as Error).message}`); }
  return validatePluginManifest(raw);
}
const manifestFiles = (manifest: PluginManifest): string[] => [manifest.main, manifest.server, manifest.icon, ...manifest.styles, ...manifest.themes.map((theme) => theme.css)].filter((file): file is string => Boolean(file));
const missingFile = (file: string): never => fail(`plugin.json names ${file}, but the file is missing.`);
/** Reads and validates a plugin folder's plugin.json; every file it names must exist. */
export const readManifest = (directory: string): PluginManifest => {
  const manifest = parseManifest(() => readFileSync(join(directory, 'plugin.json'), 'utf8'));
  for (const file of manifestFiles(manifest)) if (!existsSync(join(directory, file))) missingFile(file);
  return manifest;
};
/** readManifest without blocking the server, which re-reads plugins on every listing. */
export async function loadManifest(directory: string): Promise<PluginManifest> {
  const text = await readFile(join(directory, 'plugin.json'), 'utf8').catch((error: unknown) => error as Error);
  const manifest = parseManifest(() => { if (text instanceof Error) throw text; return text; });
  for (const file of manifestFiles(manifest)) if (!await exists(join(directory, file))) missingFile(file);
  return manifest;
}
export const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
