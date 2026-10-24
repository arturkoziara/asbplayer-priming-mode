import { describe, expect, it } from '@jest/globals';
import {
    buildPrimingTrackKinds,
    classifySubtitleTrack,
    formatPrimingDrillSize,
    formatPrimingSequence,
    nextPrimingDrillSize,
    nextPrimingLinesPerDrill,
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

    it('cycles lines per drill from 1 through 5 and back to 1', () => {
        expect(nextPrimingLinesPerDrill(1)).toBe(2);
        expect(nextPrimingLinesPerDrill(4)).toBe(5);
        expect(nextPrimingLinesPerDrill(5)).toBe(1);
    });

    it('cycles drill size through line counts then seconds presets and back to ×1', () => {
        expect(nextPrimingDrillSize({ linesPerDrill: 4, drillSeconds: 0 })).toEqual({
            linesPerDrill: 5,
            drillSeconds: 0,
        });
        expect(nextPrimingDrillSize({ linesPerDrill: 5, drillSeconds: 0 })).toEqual({
            linesPerDrill: 1,
            drillSeconds: 10,
        });
        expect(nextPrimingDrillSize({ linesPerDrill: 1, drillSeconds: 10 })).toEqual({
            linesPerDrill: 1,
            drillSeconds: 15,
        });
        expect(nextPrimingDrillSize({ linesPerDrill: 1, drillSeconds: 30 })).toEqual({
            linesPerDrill: 1,
            drillSeconds: 0,
        });
        expect(formatPrimingDrillSize({ linesPerDrill: 3, drillSeconds: 0 })).toBe('×3');
        expect(formatPrimingDrillSize({ linesPerDrill: 1, drillSeconds: 15 })).toBe('15s');
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

    it('disambiguates two EN-classified tracks using subtitle text', () => {
        const tracks = buildPrimingTrackKinds(
            [
                { track: 0, text: 'If you would like to read the script for this episode' },
                { track: 1, text: 'このエピソードのスクリプトを読みたい場合' },
            ],
            ['transcript.srt', 'transcript.srt']
        );
        expect(visibleTracksForPass('en', tracks)).toEqual([0]);
        expect(visibleTracksForPass('jp', tracks)).toEqual([1]);
    });
});
