import * as fs from 'fs/promises';
import * as path from 'path';
import { Session, SessionStorage } from '../types';

export class JsonSessionStorage implements SessionStorage {
  constructor(private readonly dir: string) {}

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async listSessions(): Promise<Session[]> {
    await this.ensureDir();
    const files = await fs.readdir(this.dir);
    const sessions = await Promise.all(
      files
        .filter(f => f.endsWith('.json') && !f.endsWith('.tmp.json'))
        .map(async f => {
          const content = await fs.readFile(path.join(this.dir, f), 'utf-8');
          return JSON.parse(content) as Session;
        })
    );
    return sessions.sort(
      (a, b) => new Date(b.lastSavedAt).getTime() - new Date(a.lastSavedAt).getTime()
    );
  }

  async loadSession(id: string): Promise<Session> {
    const content = await fs.readFile(path.join(this.dir, `${id}.json`), 'utf-8');
    return JSON.parse(content) as Session;
  }

  async saveSession(session: Session): Promise<void> {
    await this.ensureDir();
    const filePath = path.join(this.dir, `${session.id}.json`);
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(session, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
  }

  async deleteSession(id: string): Promise<void> {
    await fs.unlink(path.join(this.dir, `${id}.json`));
  }
}
