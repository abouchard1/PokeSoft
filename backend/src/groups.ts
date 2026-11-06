import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** A named group of member ids (account ids or proxy ids — the store is generic). */
export interface Group {
  id: string;
  name: string;
  memberIds: string[];
  createdAt: number;
  updatedAt: number;
}

class GroupsStore {
  private groups: Group[] = [];

  constructor(private path: string) {
    this.load();
  }

  private load() {
    if (!existsSync(this.path)) {
      this.groups = [];
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      this.groups = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.groups = [];
    }
  }

  private persist() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.groups, null, 2), 'utf8');
  }

  list(): Group[] {
    return [...this.groups].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): Group | undefined {
    return this.groups.find((g) => g.id === id);
  }

  create(name: string): Group {
    const now = Date.now();
    const group: Group = {
      id: randomUUID(),
      name: name.trim(),
      memberIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.groups.push(group);
    this.persist();
    return group;
  }

  update(id: string, patch: { name?: string; memberIds?: string[] }): Group | undefined {
    const group = this.groups.find((g) => g.id === id);
    if (!group) return undefined;
    if (patch.name !== undefined) group.name = patch.name.trim();
    if (patch.memberIds !== undefined) group.memberIds = Array.from(new Set(patch.memberIds));
    group.updatedAt = Date.now();
    this.persist();
    return group;
  }

  delete(id: string): boolean {
    const before = this.groups.length;
    this.groups = this.groups.filter((g) => g.id !== id);
    if (this.groups.length === before) return false;
    this.persist();
    return true;
  }

  /** Drop a member id from every group (call when the account/proxy is deleted). */
  removeMemberEverywhere(memberId: string) {
    let changed = false;
    for (const g of this.groups) {
      const next = g.memberIds.filter((id) => id !== memberId);
      if (next.length !== g.memberIds.length) {
        g.memberIds = next;
        g.updatedAt = Date.now();
        changed = true;
      }
    }
    if (changed) this.persist();
  }
}

const dataDir = resolve(process.cwd(), '..', 'data');

export const accountGroupsStore = new GroupsStore(
  process.env.ACCOUNT_GROUPS_FILE ?? resolve(dataDir, 'account-groups.json')
);
export const proxyGroupsStore = new GroupsStore(
  process.env.PROXY_GROUPS_FILE ?? resolve(dataDir, 'proxy-groups.json')
);
