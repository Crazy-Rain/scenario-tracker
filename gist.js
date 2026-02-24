// ============================================================
// gist.js — GitHub Gist read/write for Scenario State Tracker
// ============================================================

const TOKEN_KEY     = 'sst_gist_token';
const CHAT_MAP_KEY  = 'sst_chat_gist_map';
const LAST_GIST_KEY = 'sst_last_gist_id';   // ← global fallback — survives any chat change
const SCENARIO_KEY  = 'sst_scenario_config'; // ← extraction config storage

// ── Token ─────────────────────────────────────────────────────
export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token.trim());
}

// ── Gist ID — per-chat map + global fallback ──────────────────
// Per-chat: exact match for the current chat file
// Global fallback: last ID used in any chat — covers page refresh
//   before chat_changed fires, format mismatches, new chats that
//   should default to the same Gist as the previous session.

function getChatGistMap() {
  try { return JSON.parse(localStorage.getItem(CHAT_MAP_KEY) || '{}'); }
  catch { return {}; }
}

export function setGistForChat(chatId, gistId) {
  const map = getChatGistMap();
  map[chatId] = gistId;
  localStorage.setItem(CHAT_MAP_KEY, JSON.stringify(map));
  // Also update global fallback so a page refresh always gets the last used ID
  localStorage.setItem(LAST_GIST_KEY, gistId);
}

export function getGistIdForChat(chatId) {
  // Try per-chat map first (exact match)
  const perChat = getChatGistMap()[chatId];
  if (perChat) return perChat;
  // Fall back to last globally used ID — covers refresh before chatId is known
  return localStorage.getItem(LAST_GIST_KEY) || null;
}

export function getLastGistId() {
  return localStorage.getItem(LAST_GIST_KEY) || null;
}

// ── Scenario config (name + custom extraction prompt) ─────────
export function getScenarioConfig() {
  try {
    return JSON.parse(localStorage.getItem(SCENARIO_KEY) || '{}');
  } catch { return {}; }
}
export function setScenarioConfig(cfg) {
  localStorage.setItem(SCENARIO_KEY, JSON.stringify(cfg));
}

// ── Fetch all files from a Gist ──────────────────────────────
export async function fetchGistFiles(gistId) {
  const token = getToken();
  if (!token) throw new Error('No GitHub token set. Enter your PAT in the tracker panel.');

  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gist fetch failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const parsed = {};

  for (const [filename, fileObj] of Object.entries(data.files)) {
    let content = fileObj.content;
    if (fileObj.truncated && fileObj.raw_url) {
      const raw = await fetch(fileObj.raw_url);
      content = await raw.text();
    }
    try { parsed[filename] = JSON.parse(content); }
    catch { parsed[filename] = content; }
  }

  return parsed;
}

// ── Update files on a Gist (PATCH) ───────────────────────────
export async function updateGistFiles(gistId, filesObj) {
  const token = getToken();
  if (!token) throw new Error('No GitHub token set.');

  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ files: filesObj })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gist update failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return await res.json();
}

// ── Create a new Gist ─────────────────────────────────────────
export async function createGist(description, filesObj) {
  const token = getToken();
  if (!token) throw new Error('No GitHub token set.');

  const res = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ description, public: false, files: filesObj })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gist create failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return await res.json();
}

// ── Scaffold a blank NPC file (generic — works for any scenario) ──
export function scaffoldNpcFile(displayName, alias, faction, firstAppeared) {
  return {
    display_name: displayName,
    alias: alias || '',
    aliases: alias ? [alias] : [],
    faction: faction || 'Unknown',
    first_appeared: firstAppeared || '',
    age: '',
    appearance: {},
    personality: '',
    history: '',
    abilities: '',          // generic: power, skill, magic, etc.
    knowledge: {
      specific_intel: [],
      visibility_gates: {}
    },
    current_state: {
      relationship_to_user_character: 'not yet met',
      emotional_state: '',
      physical_state: ''
    }
  };
}

// ── Default file templates for a fresh Gist ──────────────────
// Generic — scenario-agnostic. User fills in setting details.
export function defaultIndex(chatId) {
  return {
    schema_version: '1.0',
    setting: 'My Scenario',
    chat_id: chatId || '',
    current_arc: '1',
    current_chapter: '1.1',
    in_world_date: '',
    divergence_rating: 0,
    divergence_threshold: 15,
    timeline_reliable: true,
    active_npcs: [],
    last_updated: new Date().toISOString(),
    notes: ''
  };
}

export function defaultWorldState() {
  return {
    in_world_date: '',
    arc: '1',
    chapter: '1.1',
    faction_status: {},
    active_situations: [],
    known_secrets: {},
    divergence: { rating: 0, threshold: 15, timeline_reliable: true, logged_divergences: [] }
  };
}

export function defaultArcEvents() {
  return { arc_1: {} };
}
