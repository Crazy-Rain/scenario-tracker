// ============================================================
// parser.js — Response parsing & extraction for Scenario State Tracker
// ============================================================

import { getScenarioConfig } from './gist.js';

// ── Strip internal reasoning blocks ──────────────────────────
export function stripThinkingBlocks(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<council[\s\S]*?<\/council>/gi, '')
    .replace(/<lumiaooc>[\s\S]*?<\/lumiaooc>/gi, '')
    .replace(/```wst[\s\S]*?```/gi, '')    // strip wst blocks — handled separately
    .trim();
}

// ── Continue detection & merging ─────────────────────────────
export function mergeWithPreviousIfContinue(currentText, previousText, isContinue) {
  if (!isContinue || !previousText) return currentText;
  return previousText.trim() + ' ' + currentText.trim();
}

// ── Build the extraction prompt ───────────────────────────────
// Uses user-configured scenario context if set; falls back to
// generic RP extraction that works for any setting.
export function buildExtractionPrompt(responseText, currentState) {
  const config = getScenarioConfig();
  const scenarioContext = (config.extraction_prompt || '').trim();

  const genericPrompt = `You are a state extraction assistant for a roleplay session. Read the narrative response below and compare it against the current tracked state. Identify ONLY concrete, confirmed changes — things that definitively happened in the text, not inferences or possibilities.

Return a single JSON object only. If nothing changed, return {}.

Categories to check:

npc_knowledge: Did any NPC learn something new about the PC or world?
  Format: { "npc_filename.json": { "knowledge.field": newValue } }

npc_relationship: Did any NPC's relationship to the PC visibly shift?
  Format: { "npc_filename.json": "new relationship description" }

npc_current_state: Physical or emotional state changes for any NPC.
  Format: { "npc_filename.json": { "emotional_state": "...", "physical_state": "..." } }

arc_events: Did any tracked story event fire, get altered, or get skipped?
  Format: { "event_id": "fired-canon" | "fired-altered" | "skipped" }

new_npcs: Were any new named characters introduced not yet in the tracker?
  Format: [{ "display_name": "", "alias": "", "aliases": [], "faction": "", "first_appeared": "" }]

npc_appearance: Did the narrative visually describe any NPC's physical appearance concretely?
  Only propose if specific visual details were described (hair, eyes, height, build, clothing, marks).
  Format: { "npc_filename.json": { "hair": "...", "eyes": "...", "height": "...", "build": "...", "face": "...", "clothing_style": "...", "distinguishing_marks": "..." } }
  Include ONLY fields actually described. Omit null/unknown fields entirely.

npc_aliases: Did any NPC reveal, adopt, or lose a name or alias?
  Format: { "npc_filename.json": { "alias": "primary name", "aliases": ["all known names"] } }

world_state: Any setting-level changes (factions, territory, public knowledge, active situations)?
  Format: { "field_name": newValue }

divergence_delta: Integer — how many new story-altering events were confirmed? 0 if none.

in_world_date: Updated date string if time advanced in-scene, otherwise null.`;

  // Prepend scenario-specific context if the user provided it.
  // Their context sits at the top so the model reads the setting before the schema.
  const fullPrompt = scenarioContext
    ? `SCENARIO CONTEXT:\n${scenarioContext}\n\n${genericPrompt}`
    : genericPrompt;

  return `${fullPrompt}

CURRENT STATE SUMMARY:
${JSON.stringify(currentState, null, 2)}

NARRATIVE RESPONSE TO ANALYZE:
${responseText}

Return JSON only. No explanation. No markdown fences. No prose.`;
}

// ── Run extraction via ST's existing API connection ──────────
export async function runExtractionCall(prompt) {
  const ctx = window.SillyTavern?.getContext?.();
  if (ctx && typeof ctx.generateQuietPrompt === 'function') {
    return await ctx.generateQuietPrompt(prompt, false, true);
  }
  if (typeof window.generateQuietPrompt === 'function') {
    return await window.generateQuietPrompt(prompt, false, true);
  }
  throw new Error('generateQuietPrompt not available — check SillyTavern version compatibility.');
}

// ── Extract wst block from raw message text ──────────────────
// Run this on RAW text BEFORE stripThinkingBlocks (which strips wst blocks).
export function extractForgeBlock(rawText) {
  if (!rawText) return null;
  const match = rawText.match(/```wst\s*([\s\S]*?)```/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch (e) {
    console.warn('[ScenarioTracker] wst block parse failed:', e.message, '| raw:', match[1].slice(0, 200));
    return null;
  }
}

// ── Normalise a wst block → internal delta format ────────────
export function normalizeForgeBlock(forgeObj, gistFiles = {}) {
  if (!forgeObj || typeof forgeObj !== 'object') return null;
  const delta = {};

  if (forgeObj.divergence_delta > 0) {
    delta.divergence_delta = Number(forgeObj.divergence_delta) || 0;
  }

  const newDate = forgeObj.in_world_date ?? forgeObj.world_state?.in_world_date ?? null;
  if (newDate && typeof newDate === 'string') delta.in_world_date = newDate;

  if (forgeObj.world_state && typeof forgeObj.world_state === 'object') {
    const ws = { ...forgeObj.world_state };
    delete ws.in_world_date;
    if (Object.keys(ws).length) delta.world_state = ws;
  }

  if (forgeObj.arc_event && forgeObj.arc_event !== 'null') {
    const eventKey = typeof forgeObj.arc_event === 'string'
      ? forgeObj.arc_event.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)
      : 'event_' + Date.now();
    delta.arc_events = { [eventKey]: 'fired-canon' };
  }

  // Handle npc_updates array (primary format) + legacy npc_state_change
  const updates = [];
  if (Array.isArray(forgeObj.npc_updates)) updates.push(...forgeObj.npc_updates);
  const legacyChanges = Array.isArray(forgeObj.npc_state_change)
    ? forgeObj.npc_state_change
    : (forgeObj.npc_state_change ? [forgeObj.npc_state_change] : []);
  for (const lc of legacyChanges) {
    if (lc?.name) updates.push({ name: lc.name, emotional_state: lc.change || lc.state || '' });
  }

  for (const upd of updates) {
    if (!upd?.name) continue;
    const filename = resolveNpcFilename(upd.name, gistFiles);
    if (!filename) continue;

    if (upd.relationship) {
      delta.npc_relationship = delta.npc_relationship || {};
      delta.npc_relationship[filename] = upd.relationship;
    }
    if (upd.emotional_state || upd.physical_state) {
      delta.npc_current_state = delta.npc_current_state || {};
      delta.npc_current_state[filename] = delta.npc_current_state[filename] || {};
      if (upd.emotional_state) delta.npc_current_state[filename].emotional_state = upd.emotional_state;
      if (upd.physical_state)  delta.npc_current_state[filename].physical_state  = upd.physical_state;
    }
    if (upd.learned) {
      delta.npc_knowledge = delta.npc_knowledge || {};
      delta.npc_knowledge[filename] = delta.npc_knowledge[filename] || {};
      delta.npc_knowledge[filename]['learned_' + Date.now()] = upd.learned;
    }
  }

  if (forgeObj.npc_knowledge) {
    delta.npc_knowledge = delta.npc_knowledge || {};
    Object.assign(delta.npc_knowledge, forgeObj.npc_knowledge);
  }
  if (forgeObj.npc_relationship) {
    delta.npc_relationship = delta.npc_relationship || {};
    Object.assign(delta.npc_relationship, forgeObj.npc_relationship);
  }
  if (Array.isArray(forgeObj.new_npcs)) delta.new_npcs = forgeObj.new_npcs;

  return delta;
}

// ── Resolve NPC name → Gist filename ─────────────────────────
function resolveNpcFilename(name, gistFiles) {
  if (!name || typeof name !== 'string') return null;
  const n = name.toLowerCase().trim();
  const exactKey = 'npc_' + n.replace(/\s+/g, '_') + '.json';
  if (gistFiles[exactKey]) return exactKey;
  for (const [filename, file] of Object.entries(gistFiles)) {
    if (!filename.startsWith('npc_')) continue;
    if (!file || typeof file !== 'object') continue;
    const candidates = [
      file.display_name, file.alias,
      ...(Array.isArray(file.aliases) ? file.aliases : [])
    ].filter(Boolean).map(s => s.toLowerCase());
    if (candidates.some(c => c.includes(n) || n.includes(c))) return filename;
  }
  return null;
}

// ── Parse the delta response ──────────────────────────────────
export function parseDelta(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  try {
    const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    console.warn('[ScenarioTracker] Delta parse failed on:', rawText.slice(0, 200));
    return null;
  }
}

// ── Check if delta has any actual content ─────────────────────
export function deltaIsEmpty(delta) {
  if (!delta) return true;
  return Object.keys(delta).every(k => {
    const v = delta[k];
    if (v === null || v === 0 || v === '' || v === undefined) return true;
    if (Array.isArray(v) && v.length === 0) return true;
    if (typeof v === 'object' && Object.keys(v).length === 0) return true;
    return false;
  });
}
