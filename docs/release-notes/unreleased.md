# Mindwtr Unreleased

Changes collected since the latest stable release.

- Sync: settings pages, saved filters, the task editor, Process Inbox and the project sheet no longer put back values another device synced while they were open. Only what you changed is saved, and lists (tags, contexts, checklist items, attachments) merge item by item, so nothing another device added or removed is lost.
- Sync: an edit made while a sync was saving no longer overwrites what another device had just synced. Attachments, checklist items, tags and contexts, Someday section moves and Undo now apply to the task or project as sync left it, so the other device's change stays.
- Mobile: a recovery snapshot taken right after the phone's clock went back is no longer deleted at once. Before, five snapshots named for the later time outranked it, so Undo on that import or restore could not find its snapshot.
- Mobile: restoring a recovery snapshot larger than the backup limit (128 MB) now stops with the backup's "file is too large" message before it is read into memory, as a picked backup file already does.
- Mobile: a failed Restore backup, Merge backup or snapshot restore shows the failure's own words, without the "Error:" prefix.
- Android: a backup cut short while it was written into a picked folder (the app was closed mid-write) is deleted when Settings › Data opens again or the next export starts, so a partial file no longer looks like a finished backup.
- Mobile: restoring a backup or a recovery snapshot no longer turns App Lock off. App Lock belongs to the phone: a restore keeps it on, whatever the backup file says.
- Mobile: an import or backup preview and its result leave a blank line before the project list and before the warnings, as they always meant to; the lines ran together before.
- Mobile: while Settings › Data › Getting Started is adding its tutorial project, the export, restore and import rows wait. Before, a restore started at that moment could replace the library under the new project.
- Imports: a ZIP export whose recorded file sizes do not match its contents is refused as damaged. Before, such a file could import only part of a list, or count one file many times.
- Mobile: a Calendar week with a deadline opens on the selected day (else today). Deadlines widen each day column, so fewer days fit; the week used to open on an earlier day, with the selected day off screen.
