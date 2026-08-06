import { storeValue } from "./storage";

export interface CostEntry {
  threadId: string;
  projectPath: string;
  cost: number;
  day: string;
  updatedAt: number;
}

const LEDGER_KEY = "kiwi.costLedger";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// `costTotals` runs on every App render, so re-parsing the stored ledger each
// time put a full JSON.parse of the whole spend history (hundreds of KB for a
// long-lived install) on the render path. The parse result is cached against
// the exact raw string it came from, so a write from anywhere else — another
// module, a test's localStorage.clear() — is still picked up, while a repeat
// read only costs the string comparison.
let cachedRaw: string | null | undefined;
let cachedEntries: CostEntry[] | null = null;

function ledger(): CostEntry[] {
  const raw = localStorage.getItem(LEDGER_KEY);
  if (cachedEntries && raw === cachedRaw) return cachedEntries;
  cachedRaw = raw;
  cachedEntries = parseEntries(raw);
  return cachedEntries;
}

function parseEntries(raw: string | null): CostEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as CostEntry[]) : [];
  } catch {
    return [];
  }
}

/** Clears the module cache after tests or explicit storage resets. */
export function resetCostLedgerCache(): void {
  cachedRaw = undefined;
  cachedEntries = null;
}

/**
 * Stores each thread's cumulative OpenRouter cost estimate so the Usage tab
 * can show spend across threads, not just the open one. Entries store the
 * incremental cost added on a given day, which keeps "today" accurate even
 * when a long-running thread spans multiple dates.
 */
export function recordThreadCost(threadId: string, projectPath: string, cost: number): void {
  if (!threadId || !Number.isFinite(cost) || cost <= 0) return;
  const entries = ledger();
  let previousTotal = 0;
  for (const entry of entries) {
    if (entry.threadId === threadId) previousTotal += entry.cost;
  }
  const incrementalCost = Math.max(0, cost - previousTotal);
  if (incrementalCost <= 0) return;
  const day = today();
  const next = [...entries];
  const existing = next.findIndex((entry) => entry.threadId === threadId && entry.day === day);
  if (existing >= 0) {
    next[existing] = { ...next[existing], cost: next[existing].cost + incrementalCost, projectPath, updatedAt: Date.now() };
  } else {
    next.push({ threadId, projectPath, cost: incrementalCost, day, updatedAt: Date.now() });
  }
  next.sort((left, right) => right.updatedAt - left.updatedAt);
  storeValue(LEDGER_KEY, next);
  // Costs are recorded once per turn, so re-reading the stored string once on
  // the next read is cheaper than serializing it a second time here.
  resetCostLedgerCache();
}

export function costTotals(projectPath?: string): { today: number; project: number } {
  const day = today();
  let todayTotal = 0;
  let projectTotal = 0;
  for (const entry of ledger()) {
    if (entry.day === day) todayTotal += entry.cost;
    if (projectPath && entry.projectPath === projectPath) projectTotal += entry.cost;
  }
  return { today: todayTotal, project: projectTotal };
}

export function formatCost(value: number): string {
  if (value <= 0) return "$0";
  return value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}
