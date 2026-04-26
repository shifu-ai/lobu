import type { Watcher } from '@/lib/api';

export interface WatcherGroup {
  groupId: string;
  name: string;
  description?: string;
  schedule: string | null;
  assignments: Watcher[];
  assignmentsCount: number;
  activeAssignmentsCount: number;
  archivedAssignmentsCount: number;
  totalWindowsCount: number;
}

export function getWatcherGroupId(
  watcher: Pick<Watcher, 'watcher_group_id' | 'watcher_id'>
): string {
  return String(watcher.watcher_group_id ?? watcher.watcher_id);
}

export function getWatcherGroupName(assignments: Watcher[]): string {
  const first = assignments[0];
  if (!first) return 'Watcher';
  if (assignments.length === 1) return first.name;

  const colonIdx = first.name.indexOf(':');
  if (colonIdx > 0) {
    return first.name.slice(0, colonIdx).trim();
  }

  return first.name;
}

export function groupWatchers(assignments: Watcher[]): WatcherGroup[] {
  const groups = new Map<string, Watcher[]>();

  for (const watcher of assignments) {
    const groupId = getWatcherGroupId(watcher);
    const list = groups.get(groupId) ?? [];
    list.push(watcher);
    groups.set(groupId, list);
  }

  return Array.from(groups.entries())
    .map(([groupId, groupAssignments]) => {
      const first = groupAssignments[0];
      return {
        groupId,
        name: getWatcherGroupName(groupAssignments),
        description: groupAssignments.find((item) => item.description)?.description,
        schedule: first?.schedule ?? null,
        assignments: groupAssignments,
        assignmentsCount: groupAssignments.length,
        activeAssignmentsCount: groupAssignments.filter((item) => item.status === 'active').length,
        archivedAssignmentsCount: groupAssignments.filter((item) => item.status === 'archived')
          .length,
        totalWindowsCount: groupAssignments.reduce(
          (sum, item) => sum + (item.windows_count ?? 0),
          0
        ),
      } satisfies WatcherGroup;
    })
    .sort((a, b) => b.assignmentsCount - a.assignmentsCount || a.name.localeCompare(b.name));
}

export function findWatcherGroup(
  assignments: Watcher[],
  groupIdOrWatcherId?: string
): WatcherGroup | null {
  if (!groupIdOrWatcherId) return null;

  const groups = groupWatchers(assignments);
  return (
    groups.find(
      (group) =>
        group.groupId === groupIdOrWatcherId ||
        group.assignments.some((assignment) => assignment.watcher_id === groupIdOrWatcherId)
    ) ?? null
  );
}
