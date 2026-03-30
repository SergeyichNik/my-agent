import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { LTMEntry, WorkingMemory } from '../types';

const DEFAULT_MEMORY_DIR = path.join(__dirname, '../../memory');

export class MemoryManager {
  private readonly ltmPath: string;
  private readonly logPath: string;
  private readonly wmStatePath: string;
  private entries: LTMEntry[];

  constructor(memoryDir: string = DEFAULT_MEMORY_DIR) {
    fs.mkdirSync(memoryDir, { recursive: true });
    this.ltmPath    = path.join(memoryDir, 'ltm.json');
    this.logPath    = path.join(memoryDir, 'ltm-log.jsonl');
    this.wmStatePath = path.join(memoryDir, 'wm-state.json');
    this.entries = this.loadLTM();
  }

  getAll(): LTMEntry[] {
    return this.entries;
  }

  addEntry(content: string, sessionId: string): LTMEntry {
    const entry: LTMEntry = {
      id: crypto.randomUUID(),
      content,
      addedAt: new Date().toISOString(),
      source: sessionId,
    };
    this.entries.push(entry);
    this.saveLTM();
    this.appendLog(entry);
    return entry;
  }

  saveWMState(wm: WorkingMemory): void {
    try {
      fs.writeFileSync(this.wmStatePath, JSON.stringify(wm, null, 2));
    } catch {
      // non-critical
    }
  }

  getLogPath(): string {
    return this.logPath;
  }

  getWMStatePath(): string {
    return this.wmStatePath;
  }

  private loadLTM(): LTMEntry[] {
    try {
      const raw = fs.readFileSync(this.ltmPath, 'utf-8');
      return JSON.parse(raw) as LTMEntry[];
    } catch {
      return [];
    }
  }

  private saveLTM(): void {
    fs.writeFileSync(this.ltmPath, JSON.stringify(this.entries, null, 2));
  }

  private appendLog(entry: LTMEntry): void {
    try {
      fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
    } catch {
      // non-critical
    }
  }
}
