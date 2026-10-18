import { requireNativeModule } from 'expo-modules-core';

import { logInfo, logWarn } from './app-log';

// File Sync's Storage Access Framework document calls (SafDocumentsCore.kt in the
// sync-file-transition-cas module). Unlike expo's SAF listing (androidx's TreeDocumentFile,
// which returns what it has when the provider's query throws) these reject on every provider
// failure, so an unreadable folder is never mistaken for an empty one.

export const SAF_DOCUMENTS_UNAVAILABLE = 'SAF_DOCUMENTS_UNAVAILABLE';

/** One document as the provider describes it: its tree document URI and display name. */
export type SafDocumentEntry = {
  uri: string;
  name: string | null;
  mime: string | null;
  size: number | null;
  lastModified: number | null;
};

type SafDocumentsNativeModule = {
  listChildrenAsync(uri: string): Promise<SafDocumentEntry[]>;
  statAsync(uri: string): Promise<SafDocumentEntry | null>;
};

let testModule: SafDocumentsNativeModule | null | undefined;
let resolvedModule: SafDocumentsNativeModule | null | undefined;

const getModule = (): SafDocumentsNativeModule => {
  if (testModule !== undefined) {
    if (!testModule) throw new Error(`${SAF_DOCUMENTS_UNAVAILABLE}: SAF document calls are unavailable in this build`);
    return testModule;
  }
  if (resolvedModule === undefined) {
    try {
      resolvedModule = requireNativeModule<SafDocumentsNativeModule>('SyncFileTransitionCas');
    } catch {
      resolvedModule = null;
    }
  }
  if (!resolvedModule?.listChildrenAsync || !resolvedModule.statAsync) {
    throw new Error(`${SAF_DOCUMENTS_UNAVAILABLE}: SAF document calls are unavailable in this build`);
  }
  return resolvedModule;
};

const RELEASE_CHECK = 'v1.3.7/file-sync-saf-safety';
let listedOnce = false;

/** One proving line per process for a listing that ran through SafDocumentsCore, and one per
 *  provider error it surfaced instead of answering "empty" or "absent". */
const traced = async <T>(check: 'listing' | 'lookup', call: () => Promise<T>): Promise<T> => {
  try {
    const value = await call();
    if (check === 'listing' && !listedOnce) {
      listedOnce = true;
      void logInfo('File Sync folder listed through SafDocumentsCore', {
        scope: 'sync', extra: { releaseCheck: RELEASE_CHECK, check, outcome: 'listed' },
      });
    }
    return value;
  } catch (error) {
    void logWarn('File Sync provider error kept the folder unread', {
      scope: 'sync', extra: { releaseCheck: RELEASE_CHECK, check, outcome: 'refused' },
    });
    throw error;
  }
};

/** The documents in a SAF folder; empty only when the provider listed an empty folder. */
export const listSafChildren = async (dirUri: string): Promise<SafDocumentEntry[]> =>
  traced('listing', () => getModule().listChildrenAsync(dirUri));

/** A SAF document's row, or null when the provider's query answered no such document (a
 *  query with no answer rejects: it proves nothing). */
export const statSafDocument = async (uri: string): Promise<SafDocumentEntry | null> =>
  traced('lookup', () => getModule().statAsync(uri));

export const setSafDocumentsNativeModuleForTests = (
  nativeModule: SafDocumentsNativeModule | null | undefined,
): void => {
  testModule = nativeModule;
  resolvedModule = undefined;
};
