import { loadStored, storeValue } from "./storage";

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

/**
 * Stores each thread's cumulative OpenRouter cost estimate so the Usage tab
 * can show spend across threads, not just the open one. Entries store the
 * incremental cost added on a given day, which keeps "today" accurate even
 * when a long-running thread spans multiple dates.
 */
export function recordThreadCost(threadId: string, projectPath: string, cost: number): void {
  if (!threadId || !Number.isFinite(cost) || cost <= 0) return;
  const stored = loadStored<CostEntry[]>(LEDGER_KEY, []);
  const ledger = Array.isArray(stored) ? stored : [];
  const previousTotal = ledger
    .filter((entry) => entry.threadId === threadId)
    .reduce((sum, entry) => sum + entry.cost, 0);
  const incrementalCost = Math.max(0, cost - previousTotal);
  if (incrementalCost <= 0) return;
  const day = today();
  const existing = ledger.find((entry) => entry.threadId === threadId && entry.day === day);
  if (existing) {
    existing.cost += incrementalCost;
    existing.projectPath = projectPath;
    existing.updatedAt = Date.now();
  } else {
    ledger.push({ threadId, projectPath, cost: incrementalCost, day, updatedAt: Date.now() });
  }
  ledger.sort((left, right) => right.updatedAt - left.updatedAt);
  storeValue(LEDGER_KEY, ledger);
}

export function costTotals(projectPath?: string): { today: number; project: number } {
  const ledger = loadStored<CostEntry[]>(LEDGER_KEY, []);
  const day = today();
  let todayTotal = 0;
  let projectTotal = 0;
  for (const entry of ledger) {
    if (entry.day === day) todayTotal += entry.cost;
    if (projectPath && entry.projectPath === projectPath) projectTotal += entry.cost;
  }
  return { today: todayTotal, project: projectTotal };
}

export function formatCost(value: number): string {
  if (value <= 0) return "$0";
  return value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}
