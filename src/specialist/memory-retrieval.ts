const DEFAULT_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'i', 'if', 'in', 'is', 'it',
  'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'we', 'with', 'you', 'your', 'replace',
  'implement', 'task', 'run', 'add', 'new', 'use', 'using', 'into', 'when', 'what', 'not', 'only',
]);

const MAX_KEYWORDS = 6;
const CACHE_MAX_AGE_MS = 60 * 60 * 1000;

export const STATIC_WORKFLOW_RULES_BLOCK = `
## Beads Workflow Quick Rules
- Claim work: \`bd update <id> --claim\`
- Append progress notes: \`bd update <id> --append-notes "..."\`
- Store reusable insight: \`bd remember "insight"\`
- Close completed issue: \`bd close <id> --reason "done"\`

## Session close checklist
1. \`git add <files>\`
2. \`git commit -m "..."\`
3. \`git push\`
`.trim();

export interface MemoryRecord {
  key: string;
  value: string;
}

export interface MemoryInjectionResult {
  block: string;
  memories: MemoryRecord[];
  estimatedTokens: number;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function normalizeToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').trim();
}

function extractTokens(input: string): string[] {
  return input
    .split(/\s+/g)
    .map(normalizeToken)
    .filter(token => token.length >= 3 && !DEFAULT_STOP_WORDS.has(token));
}

export function extractMemoryKeywords(title: string, description?: string): string[] {
  const tokens = [
    ...extractTokens(title),
    ...extractTokens(description ?? ''),
  ];

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
    if (unique.length >= MAX_KEYWORDS) break;
  }

  return unique;
}

export function parseMemoriesPayload(jsonText: string): MemoryRecord[] {
  if (!jsonText.trim()) return [];

  const parsed = JSON.parse(jsonText) as unknown;

  if (Array.isArray(parsed)) {
    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const maybeRecord = entry as Record<string, unknown>;
        const key = typeof maybeRecord.key === 'string' ? maybeRecord.key : null;
        const value = typeof maybeRecord.value === 'string' ? maybeRecord.value : null;
        if (!key || value === null) return null;
        return { key, value };
      })
      .filter((entry): entry is MemoryRecord => Boolean(entry));
  }

  if (parsed && typeof parsed === 'object') {
    return Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
      .map(([key, value]) => ({ key, value }));
  }

  return [];
}

export function shouldRefreshCache(args: {
  nowMs: number;
  cacheCount: number | null;
  cacheLastSyncAtMs: number | null;
  sourceCount: number;
}): boolean {
  if (args.cacheCount === null || args.cacheLastSyncAtMs === null) return true;
  if (args.cacheCount !== args.sourceCount) return true;
  return args.nowMs - args.cacheLastSyncAtMs > CACHE_MAX_AGE_MS;
}

// SQLite FTS persistence retired (unitAI-3qfjr S3). Stubs keep the module
// importable until its remaining consumers move off it.
export function syncMemoriesCacheFromBd(_cwd: string, _nowMs: number = Date.now(), _forceFullSync: boolean = false): { synced: boolean; memoryCount: number } {
  return { synced: false, memoryCount: 0 };
}

export function invalidateAndRefreshMemoriesCache(_cwd: string, _nowMs: number = Date.now()): { synced: boolean; memoryCount: number } {
  return { synced: false, memoryCount: 0 };
}

export function buildFilteredMemoryInjection(_args: {
  cwd: string;
  beadTitle: string;
  beadDescription?: string;
}): MemoryInjectionResult {
  return { block: '', memories: [], estimatedTokens: 0 };
}

export function estimateInjectedTokens(text: string): number {
  return estimateTokens(text);
}
