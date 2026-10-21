import { describe, expect, it } from 'vitest';
import {
    CONTEXTS_NO_CONTEXT_TOKEN as NONE,
    selectContextsToken,
    toggleContextsNoContext,
    toggleContextsToken,
} from './contexts-view-model';

// #1427: a plain chip press switches to that chip; the additive gesture still toggles.
describe('selectContextsToken', () => {
    it('clears the selection when the chip was the only one selected', () => {
        expect(selectContextsToken(['@home'], '@home')).toEqual([]);
        expect(selectContextsToken([NONE], NONE)).toEqual([]);
    });

    it('switches to the chip alone otherwise', () => {
        expect(selectContextsToken([], '@home')).toEqual(['@home']);
        expect(selectContextsToken(['@work'], '@home')).toEqual(['@home']);
        expect(selectContextsToken(['@home', '#a'], '@home')).toEqual(['@home']);
        expect(selectContextsToken(['@home', '#a'], '#b')).toEqual(['#b']);
    });

    it('keeps No context exclusive', () => {
        expect(selectContextsToken([NONE], '@home')).toEqual(['@home']);
        expect(selectContextsToken(['@home', '#a'], NONE)).toEqual([NONE]);
        expect(selectContextsToken([], NONE)).toEqual([NONE]);
    });

    it('leaves the additive toggle unchanged', () => {
        expect(toggleContextsToken(['@work'], '@home')).toEqual(['@work', '@home']);
        expect(toggleContextsToken(['@work', '@home'], '@home')).toEqual(['@work']);
        expect(toggleContextsToken([NONE], '@home')).toEqual(['@home']);
        expect(toggleContextsNoContext(['@home'])).toEqual([NONE]);
        expect(toggleContextsNoContext([NONE])).toEqual([]);
    });
});
