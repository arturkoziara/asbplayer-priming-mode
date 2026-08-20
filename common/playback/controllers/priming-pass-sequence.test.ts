import { describe, expect, it } from '@jest/globals';
import {
    classifySubtitleTrack,
    formatPrimingSequence,
    nextPrimingSequence,
    preferredDrillTrack,
    visibleTracksForPass,
} from './priming-pass-sequence';

describe('priming pass sequence', () => {
    it('formats overlay labels', () => {
        expect(formatPrimingSequence(['en', 'raw', 'jp'])).toBe('EN → RAW → JP');
    });

    it('cycles overlay presets', () => {
        expect(nextPrimingSequence(['en', 'raw', 'jp'])).toEqual(['en', 'jp']);
        expect(nextPrimingSequence(['en', 'jp'])).toEqual(['en', 'raw']);
        expect(nextPrimingSequence(['en', 'en', 'jp'])).toEqual(['en', 'raw', 'jp']);
    });

    it('classifies tracks from filenames and text', () => {
        expect(classifySubtitleTrack('Video - Japanese.srt', '')).toBe('jp');
        expect(classifySubtitleTrack('Video - English.srt', '')).toBe('en');
        expect(classifySubtitleTrack('Learn Japanese - en - English.nfimsc', '')).toBe('en');
        expect(classifySubtitleTrack('Show - ja - Japanese.nfimsc', '')).toBe('jp');
        expect(classifySubtitleTrack('track0.srt', 'このエピソードのスクリプトを読みたい')).toBe('jp');
        expect(classifySubtitleTrack('track1.srt', 'If you would like to read the script for this episode')).toBe('en');
    });

    it('shows EN then nothing then JP regardless of track order', () => {
        const tracks = new Map<number, 'en' | 'jp' | 'unknown'>([
            [0, 'jp'],
            [1, 'en'],
        ]);
        expect(visibleTracksForPass('en', tracks)).toEqual([1]);
        expect(visibleTracksForPass('raw', tracks)).toEqual([]);
        expect(visibleTracksForPass('jp', tracks)).toEqual([0]);
        expect(preferredDrillTrack(tracks)).toBe(0);
    });

    it('splits two unclassified tracks into EN then JP', () => {
        const tracks = new Map<number, 'en' | 'jp' | 'unknown'>([
            [0, 'unknown'],
            [1, 'unknown'],
        ]);
        expect(visibleTracksForPass('en', tracks)).toEqual([0]);
        expect(visibleTracksForPass('raw', tracks)).toEqual([]);
        expect(visibleTracksForPass('jp', tracks)).toEqual([1]);
    });
});
