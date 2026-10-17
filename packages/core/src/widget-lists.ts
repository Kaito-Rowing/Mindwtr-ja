import type { FocusTaskLists } from './focus-sections';
import { compareSomedayTasks, compareWaitingTasks } from './menu-views-model';
import { applyFilter, normalizeSavedFilters } from './saved-filters';
import { sortTasksBy, sortTasksBySavedPreference } from './task-utils';
import type { AppData, SavedFilter, Task, TaskSortBy } from './types';

// The lists a placed Tasks widget can show (#1173): Mindwtr's own GTD lists,
// each in the order its screen uses, plus any saved filter. `focus` is the
// sectioned Focus layout widget-payload.ts already builds; the others are defined
// here, once. A single project is covered by a saved filter scoped to it.
export const WIDGET_FIXED_LIST_IDS = ['focus', 'inbox', 'next', 'waiting', 'someday', 'upcoming'] as const;
export type WidgetFixedListId = (typeof WIDGET_FIXED_LIST_IDS)[number];
export const WIDGET_SAVED_FILTER_LIST_PREFIX = 'filter:';
export const WIDGET_SAVED_FILTER_OPTION_CAP = 50;

const LIST_TITLE_KEYS: Record<WidgetFixedListId, [string, string]> = {
    focus: ['nav.agenda', 'Focus'],
    inbox: ['nav.inbox', 'Inbox'],
    next: ['nav.next', 'Next Actions'],
    waiting: ['nav.waiting', 'Waiting For'],
    someday: ['nav.someday', 'Someday/Maybe'],
    upcoming: ['agenda.upcoming', 'Upcoming'],
};

// The fixed list titles plus the group label the picker puts above its
// saved-filter rows.
export function widgetListTitles(tr: Record<string, string>): Record<WidgetFixedListId | 'savedFilters', string> {
    return {
        ...(Object.fromEntries(
            WIDGET_FIXED_LIST_IDS.map((id) => [id, tr[LIST_TITLE_KEYS[id][0]] ?? LIST_TITLE_KEYS[id][1]]),
        ) as Record<WidgetFixedListId, string>),
        savedFilters: tr['settings.syncPreferenceSavedFilters'] ?? 'Saved filters',
    };
}

export interface WidgetTaskList {
    title: string;
    tasks: Task[];
}

export interface WidgetListContext {
    data: AppData;
    /** Undeleted, actionable, in an active project: the widget's base pool. */
    activeTasks: Task[];
    focusLists: FocusTaskLists;
    sortBy: TaskSortBy;
    prioritiesEnabled: boolean;
    tr: Record<string, string>;
}

// The saved filters this build can apply, not deleted: a newer app's view is left out.
const liveSavedFilters = (data: AppData): SavedFilter[] => (
    normalizeSavedFilters(data.settings?.savedFilters).filter((filter) => !filter.deletedAt)
);

/** Saved filters the configuration screen offers, in the order the app lists them. */
export function buildWidgetSavedFilterOptions(data: AppData): { id: string; name: string }[] {
    return liveSavedFilters(data)
        .slice(0, WIDGET_SAVED_FILTER_OPTION_CAP)
        .map((filter) => ({ id: filter.id, name: filter.name }));
}

// A saved filter is written against one view, and the app only ever applies it
// on that view's list, so the widget narrows the pool the same way before
// matching. Every other view filters the full actionable pool.
const savedFilterStatus: Partial<Record<SavedFilter['view'], Task['status']>> = {
    next: 'next',
    waiting: 'waiting',
    someday: 'someday',
};

function buildSavedFilterList(filter: SavedFilter, context: WidgetListContext): WidgetTaskList {
    const { data, activeTasks, sortBy, prioritiesEnabled } = context;
    const status = savedFilterStatus[filter.view];
    const pool = status ? activeTasks.filter((task) => task.status === status) : activeTasks;
    const projects = data.projects || [];
    const matched = applyFilter(pool, filter.criteria, { projects, tokenMatchMode: 'all' });
    const tasks = filter.sortBy && filter.sortBy !== 'default'
        ? sortTasksBySavedPreference(matched, filter.sortBy, {
            projects,
            prioritizeByPriority: prioritiesEnabled,
            sortOrder: filter.sortOrder,
        })
        : sortTasksBy(matched, sortBy);
    return { title: filter.name, tasks };
}

/** Null when the id names no list (an unknown or deleted saved filter). */
export function buildWidgetTaskList(listId: string, context: WidgetListContext): WidgetTaskList | null {
    const { data, activeTasks, focusLists, sortBy, tr } = context;
    const titles = widgetListTitles(tr);
    switch (listId) {
        case 'inbox':
            return { title: titles.inbox, tasks: sortTasksBy(activeTasks.filter((task) => task.status === 'inbox'), sortBy) };
        case 'next':
            // The app's Next Actions list is the Focus screen's Next section
            // (sequential-project rules included).
            return { title: titles.next, tasks: focusLists.nextActions };
        case 'upcoming':
            return { title: titles.upcoming, tasks: focusLists.upcoming };
        case 'waiting':
            return { title: titles.waiting, tasks: activeTasks.filter((task) => task.status === 'waiting').sort(compareWaitingTasks) };
        case 'someday':
            return { title: titles.someday, tasks: activeTasks.filter((task) => task.status === 'someday').sort(compareSomedayTasks) };
        default:
            break;
    }
    if (!listId.startsWith(WIDGET_SAVED_FILTER_LIST_PREFIX)) return null;
    const filterId = listId.slice(WIDGET_SAVED_FILTER_LIST_PREFIX.length);
    const filter = liveSavedFilters(data).find((candidate) => candidate.id === filterId);
    return filter ? buildSavedFilterList(filter, context) : null;
}
