import {
    applySubtitleTrackVisibilityMode,
    detectSubtitleTrackVisibilityMode,
    loadedSubtitleTrackIndexes,
    nextSubtitleTrackVisibilityMode,
    preferredMiningTrackFromVisibility,
} from './subtitle-track-visibility';

describe('subtitle track visibility', () => {
    const loadedTracks = [0, 1];

    it('cycles through both, single track, and hidden states', () => {
        const disabled: { [key: number]: boolean | undefined } = {};

        expect(nextSubtitleTrackVisibilityMode('all')).toBe('single0');
        expect(nextSubtitleTrackVisibilityMode('single0')).toBe('single1');
        expect(nextSubtitleTrackVisibilityMode('single1')).toBe('none');
        expect(nextSubtitleTrackVisibilityMode('none')).toBe('all');

        expect(applySubtitleTrackVisibilityMode('single0', loadedTracks, disabled)).toBe(true);
        expect(detectSubtitleTrackVisibilityMode(loadedTracks, true, disabled)).toBe('single0');

        expect(applySubtitleTrackVisibilityMode('single1', loadedTracks, disabled)).toBe(true);
        expect(detectSubtitleTrackVisibilityMode(loadedTracks, true, disabled)).toBe('single1');

        expect(applySubtitleTrackVisibilityMode('none', loadedTracks, disabled)).toBe(false);
        expect(detectSubtitleTrackVisibilityMode(loadedTracks, false, disabled)).toBe('none');

        expect(applySubtitleTrackVisibilityMode('all', loadedTracks, disabled)).toBe(true);
        expect(detectSubtitleTrackVisibilityMode(loadedTracks, true, disabled)).toBe('all');
    });

    it('counts loaded tracks from subtitle cue track indices only', () => {
        const subtitles = [
            { track: 0, text: 'english' },
            { track: 1, text: 'japanese' },
        ];

        expect(loadedSubtitleTrackIndexes(subtitles)).toEqual([0, 1]);
    });

    it('returns the visible track index for mining when only one track is shown', () => {
        const disabled: { [key: number]: boolean | undefined } = {};

        applySubtitleTrackVisibilityMode('single0', loadedTracks, disabled);
        expect(preferredMiningTrackFromVisibility(loadedTracks, true, disabled)).toBe(0);

        applySubtitleTrackVisibilityMode('single1', loadedTracks, disabled);
        expect(preferredMiningTrackFromVisibility(loadedTracks, true, disabled)).toBe(1);

        applySubtitleTrackVisibilityMode('all', loadedTracks, disabled);
        expect(preferredMiningTrackFromVisibility(loadedTracks, true, disabled)).toBeUndefined();

        applySubtitleTrackVisibilityMode('none', loadedTracks, disabled);
        expect(preferredMiningTrackFromVisibility(loadedTracks, false, disabled)).toBeUndefined();
    });
});
