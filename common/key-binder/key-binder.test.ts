import { describe, expect, it } from '@jest/globals';
import type { SubtitleModel } from '@project/common/src/model';
import { previousSeekSubtitle, SubtitleSeekNavigator } from '@project/common/key-binder';

const firstTrack = 1;

// Lines: 1000-3000, 4000-6000, 7000-9000
const lines: SubtitleModel[] = [1000, 4000, 7000].map((start, index) => ({
    text: `line ${index}`,
    start,
    end: start + 2000,
    originalStart: start,
    originalEnd: start + 2000,
    track: 0,
}));

describe('SubtitleSeekNavigator', () => {
    it('previous repeats the line playing', () => {
        expect(new SubtitleSeekNavigator().target(false, 4300, lines, firstTrack)?.start).toBe(4000);
    });

    it('previous in the silence after a line repeats that line', () => {
        expect(new SubtitleSeekNavigator().target(false, 6500, lines, firstTrack)?.start).toBe(4000);
    });

    it('a quick second previous press goes back one more line', () => {
        const navigator = new SubtitleSeekNavigator();
        expect(navigator.target(false, 4300, lines, firstTrack)?.start).toBe(4000);
        expect(navigator.target(false, 4000, lines, firstTrack)?.start).toBe(1000);
    });

    it('next goes to the following line', () => {
        expect(new SubtitleSeekNavigator().target(true, 4300, lines, firstTrack)?.start).toBe(7000);
    });
});

describe('previousSeekSubtitle', () => {
    it('repeats the line playing once it is under way', () => {
        expect(previousSeekSubtitle(5000, lines, firstTrack)?.start).toBe(4000);
    });

    it('goes back one line when the current line only just started', () => {
        expect(previousSeekSubtitle(4100, lines, firstTrack)?.start).toBe(1000);
    });
});
