import type { ModelProfile, ProviderModel } from '../types.js';
import type { IAIProvider } from './types.js';

/** A model family recognised by its ID, with its relative speed, quality and cost. */
export type ModelFamily = readonly [pattern: RegExp, profile: ModelProfile];

// Tiers compare families across vendors, because Copilot, OpenCode and Antigravity list several vendors in one picker; the
// interface derives its wording from them. Most specific pattern first. Sources (2026-10): Anthropic's model overview (Fable
// above Opus, Haiku 5.5 at $0.10 / $0.50 per MTok), OpenAI's GPT-6 announcement (Astra flagship, Sol and Luna faster and
// cheaper), Google's Gemini 4 Argon and Gemini 3.8 Flash pricing.
export const CLAUDE_FAMILIES: readonly ModelFamily[] = [
  [/claude.*\b(?:fable|mythos)\b/i, { speed: 1, quality: 5, cost: 5 }],
  [/claude.*\bopus\b/i, { speed: 2, quality: 4, cost: 4 }],
  [/claude.*\bsonnet\b/i, { speed: 4, quality: 3, cost: 3 }],
  [/claude.*\bhaiku\b/i, { speed: 5, quality: 2, cost: 1 }],
];
export const OPENAI_FAMILIES: readonly ModelFamily[] = [
  [/\bgpt-[\d.]+-astra\b/i, { speed: 1, quality: 5, cost: 5 }],
  [/\bgpt-[\d.]+-sol\b/i, { speed: 4, quality: 3, cost: 3 }],
  [/\bgpt-[\d.]+-luna\b/i, { speed: 5, quality: 2, cost: 1 }],
  [/\bgpt-[\d.]+(?:-codex)?-nano\b/i, { speed: 5, quality: 1, cost: 1 }],
  [/\b(?:gpt-[\d.]+(?:-codex)?|codex|o\d)-mini\b/i, { speed: 4, quality: 2, cost: 2 }],
  [/\bgpt-[\d.]+-codex-max\b/i, { speed: 2, quality: 4, cost: 4 }],
  [/\bgpt-oss\b/i, { speed: 4, quality: 2, cost: 1 }],
  [/\bgpt-(?:[5-9]|\d{2,})(?:\.\d+)?(?:-codex)?(?:-(?:low|medium|high))?$/i, { speed: 3, quality: 3, cost: 3 }],
];
export const GEMINI_FAMILIES: readonly ModelFamily[] = [
  [/\bgemini-[\d.]+-argon\b/i, { speed: 2, quality: 5, cost: 4 }],
  [/\bgemini-[\d.]+-pro\b/i, { speed: 2, quality: 4, cost: 3 }],
  [/\bgemini-[\d.]+-flash-lite\b/i, { speed: 5, quality: 1, cost: 1 }],
  [/\bgemini-[\d.]+-flash\b/i, { speed: 4, quality: 3, cost: 2 }],
];
/** Every family above, for providers that route to several vendors. */
export const MODEL_FAMILIES: readonly ModelFamily[] = [...CLAUDE_FAMILIES, ...OPENAI_FAMILIES, ...GEMINI_FAMILIES];

const clamp = (value: number): number => Math.min(5, Math.max(1, value));
/**
 * The profile of the first family whose pattern matches the ID, or null. An ID that ends in a thinking level ("-low",
 * "-high", as Antigravity lists them) answers faster and cheaper, or slower and dearer, than its family.
 */
export function familyProfile(families: readonly ModelFamily[], id: string): ModelProfile | null {
  const profile = families.find(([pattern]) => pattern.test(id))?.[1];
  if (!profile) return null;
  const level = /-(low|high)$/i.exec(id)?.[1]?.toLowerCase(), shift = level === 'low' ? 1 : level === 'high' ? -1 : 0;
  return { speed: clamp(profile.speed + shift), quality: profile.quality, cost: clamp(profile.cost - shift) };
}

/** The model with the profile its provider knows for it; unknown models stay as they are. */
export function describeModel(provider: Pick<IAIProvider, 'modelProfile'>, model: ProviderModel): ProviderModel {
  const profile = provider.modelProfile(model.id);
  return profile ? { ...model, profile } : model;
}
