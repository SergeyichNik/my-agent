import * as fs from 'fs';
import * as path from 'path';
import { UserProfile } from '../types';

const DEFAULT_PROFILES_DIR = path.join(__dirname, '../../memory/profiles');

function emptyProfile(userId: string): UserProfile {
  return {
    userId,
    updatedAt: new Date().toISOString(),
    preferences: { style: null, tone: null, verbosity: null },
    format: { codeStyle: null, responseStructure: null },
    constraints: { preferredLanguage: null, doNot: [], must: [] },
  };
}

export class ProfileManager {
  private readonly profilesDir: string;

  constructor(profilesDir: string = DEFAULT_PROFILES_DIR) {
    this.profilesDir = profilesDir;
    fs.mkdirSync(profilesDir, { recursive: true });
  }

  load(userId: string): UserProfile {
    const filePath = this.profilePath(userId);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as UserProfile;
    } catch {
      return emptyProfile(userId);
    }
  }

  save(profile: UserProfile): void {
    profile.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.profilePath(profile.userId), JSON.stringify(profile, null, 2));
  }

  /**
   * Apply a partial update from profile_update tag.
   * Supports dot-notation keys: "preferences.style", "constraints.preferredLanguage", etc.
   * For array fields (doNot, must) the value replaces the array entirely.
   */
  applyUpdate(userId: string, updates: Record<string, unknown>): UserProfile {
    const profile = this.load(userId);
    for (const [key, value] of Object.entries(updates)) {
      const parts = key.split('.');
      if (parts.length === 2) {
        const [section, field] = parts;
        const sec = profile[section as keyof UserProfile] as Record<string, unknown>;
        if (sec && typeof sec === 'object') {
          sec[field] = value;
        }
      }
    }
    this.save(profile);
    return profile;
  }

  hasAnyPreferences(profile: UserProfile): boolean {
    const p = profile.preferences;
    const f = profile.format;
    const c = profile.constraints;
    return !!(
      p.style || p.tone || p.verbosity ||
      f.codeStyle || f.responseStructure ||
      c.preferredLanguage || c.doNot.length || c.must.length
    );
  }

  private profilePath(userId: string): string {
    // Sanitize userId to safe filename
    const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.profilesDir, `${safe}.json`);
  }
}
