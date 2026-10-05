export type ScenarioResult = {
  id: string;
  name: string;
  createdAt: string;
  occupants: number;
  exits: number;
  profile: string;
  evacuationTime: number;
  averageEvacuationTime: number | null;
  p95EvacuationTime: number | null;
  peakDensity: number;
  maxQueue: number;
  averageQueueWait: number | null;
};

const STORAGE_KEY = 'evacsim.scenario-results.v1';

export class ScenarioStore {
  private results: ScenarioResult[] = [];

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) this.results = parsed.slice(0, 20);
      }
    } catch {
      this.results = [];
    }
  }

  list() {
    return [...this.results];
  }

  add(result: Omit<ScenarioResult, 'id' | 'createdAt'>) {
    const item: ScenarioResult = {
      ...result,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };

    this.results.unshift(item);
    this.results = this.results.slice(0, 20);
    this.persist();
    return item;
  }

  clear() {
    this.results = [];
    this.persist();
  }

  private persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.results));
    } catch {
      // Comparison still works for the current session if storage is unavailable.
    }
  }
}
