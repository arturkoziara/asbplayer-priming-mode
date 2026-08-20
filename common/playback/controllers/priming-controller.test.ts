import { describe, expect, it, jest } from '@jest/globals';
import type { IndexedSubtitleModel } from '@project/common';
import { defaultPrimingSettings } from '@project/common/settings/settings';
import PrimingController, { type MediaAdapter } from './priming-controller';

const subtitles: IndexedSubtitleModel[] = [
    {
        index: 0,
        text: 'hello',
        start: 1000,
        end: 2000,
        originalStart: 1000,
        originalEnd: 2000,
        track: 0,
        displayTime: '00:01',
    },
    {
        index: 1,
        text: 'world',
        start: 3000,
        end: 5000,
        originalStart: 3000,
        originalEnd: 5000,
        track: 0,
        displayTime: '00:03',
    },
];

function createAdapter(overrides: Partial<MediaAdapter> = {}): MediaAdapter {
    let timeMs = 1500;
    const listeners = {
        seek: [] as Array<(t: number) => void>,
        pause: [] as Array<() => void>,
        play: [] as Array<() => void>,
    };

    return {
        currentTimeMs: () => timeMs,
        durationMs: () => 10000,
        seek: jest.fn(async (timestampMs: number) => {
            timeMs = timestampMs;
        }),
        play: jest.fn(async () => undefined),
        pause: jest.fn(() => undefined),
        setPlaybackRate: jest.fn(() => undefined),
        setVisibleTracks: jest.fn(() => undefined),
        setBlackout: jest.fn(() => undefined),
        waitUntilTime: jest.fn(async (targetMs: number) => {
            timeMs = targetMs;
            return true;
        }),
        cancelPendingWait: jest.fn(() => undefined),
        trackKinds: () =>
            new Map([
                [0, 'en'],
                [1, 'jp'],
            ]),
        onExternalSeek: (cb) => {
            listeners.seek.push(cb);
            return () => {
                listeners.seek = listeners.seek.filter((l) => l !== cb);
            };
        },
        onExternalPause: (cb) => {
            listeners.pause.push(cb);
            return () => {
                listeners.pause = listeners.pause.filter((l) => l !== cb);
            };
        },
        onExternalPlay: (cb) => {
            listeners.play.push(cb);
            return () => {
                listeners.play = listeners.play.filter((l) => l !== cb);
            };
        },
        onVisibilityHidden: () => () => undefined,
        onVisibilityVisible: () => () => undefined,
        ...overrides,
    };
}

describe('PrimingController', () => {
    it('sets visibility before seek on each pass', async () => {
        const media = createAdapter();
        const order: string[] = [];
        media.setVisibleTracks = jest.fn(() => order.push('visible'));
        media.seek = jest.fn(async () => {
            order.push('seek');
        });

        const controller = new PrimingController({
            settings: {
                ...defaultPrimingSettings,
                passes: [
                    { visibleTracks: [0], playbackRate: 1, gapMs: 0, gapFactor: 0, blackout: false },
                    { visibleTracks: [], playbackRate: 1, gapMs: 0, gapFactor: 0, blackout: false },
                ],
                autoAdvance: false,
                interPassGapMs: 0,
            },
            subtitles: () => subtitles,
            media,
        });

        controller.start();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(order.indexOf('visible')).toBeLessThan(order.indexOf('seek'));
        controller.stop();
    });

    it('shows EN then none then JP for the default sequence', async () => {
        const media = createAdapter();
        const visible: number[][] = [];
        media.setVisibleTracks = jest.fn((indices: readonly number[]) => {
            visible.push([...indices]);
        });

        const controller = new PrimingController({
            settings: {
                ...defaultPrimingSettings,
                passes: defaultPrimingSettings.passes.map((pass) => ({ ...pass, gapMs: 0, gapFactor: 0 })),
                autoAdvance: false,
                interPassGapMs: 0,
            },
            subtitles: () => subtitles,
            media,
        });

        controller.start();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(visible).toEqual([[0], [], [1]]);
        controller.stop();
    });

    it('applies a new pass sequence while a pass wait is hung', async () => {
        let releaseWait: ((reached: boolean) => void) | undefined;
        const media = createAdapter({
            waitUntilTime: jest.fn(
                () =>
                    new Promise<boolean>((resolve) => {
                        releaseWait = resolve;
                    })
            ),
            cancelPendingWait: jest.fn(() => {
                releaseWait?.(false);
            }),
        });
        const visible: number[][] = [];
        media.setVisibleTracks = jest.fn((indices: readonly number[]) => {
            visible.push([...indices]);
        });

        const controller = new PrimingController({
            settings: {
                ...defaultPrimingSettings,
                passSequence: ['en', 'raw', 'jp'],
                autoAdvance: false,
                interPassGapMs: 0,
            },
            subtitles: () => subtitles,
            media,
        });

        controller.start();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(media.waitUntilTime).toHaveBeenCalled();
        controller.updateSettings({
            ...defaultPrimingSettings,
            passSequence: ['jp', 'raw'],
            autoAdvance: false,
        });
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(media.cancelPendingWait).toHaveBeenCalled();
        expect(visible.at(-1)).toEqual([1]);
        controller.stop();
    });

    it('skipToNextCue advances to the next drill cue from pass one', async () => {
        const media = createAdapter();
        const cueChanges: number[] = [];

        const controller = new PrimingController({
            settings: {
                ...defaultPrimingSettings,
                passSequence: ['en', 'raw', 'jp'],
                autoAdvance: false,
                interPassGapMs: 0,
            },
            subtitles: () => subtitles,
            media,
            onCueChanged: (index) => cueChanges.push(index),
        });

        controller.start();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(cueChanges).toEqual([0]);

        controller.skipToNextCue();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(cueChanges).toEqual([0, 1]);
        controller.stop();
    });

    it('skipToPreviousCue returns to the previous drill cue', async () => {
        const media = createAdapter();
        const cueChanges: number[] = [];

        const controller = new PrimingController({
            settings: {
                ...defaultPrimingSettings,
                passSequence: ['en'],
                autoAdvance: false,
                interPassGapMs: 0,
            },
            subtitles: () => subtitles,
            media,
            onCueChanged: (index) => cueChanges.push(index),
        });

        controller.start();
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.skipToNextCue();
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.skipToPreviousCue();
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(cueChanges).toEqual([0, 1, 0]);
        controller.stop();
    });

    it('skipToNextCue skips the overlapping JP of the same line', async () => {
        const bilingual: IndexedSubtitleModel[] = [
            { ...subtitles[0], index: 0, track: 0, start: 1000, end: 2000, originalStart: 1000, originalEnd: 2000 },
            { ...subtitles[0], index: 1, text: 'こんにちは', track: 1, start: 1100, end: 2100, originalStart: 1100, originalEnd: 2100 },
            { ...subtitles[1], index: 2, track: 0, start: 3000, end: 4000, originalStart: 3000, originalEnd: 4000 },
            { ...subtitles[1], index: 3, text: '世界', track: 1, start: 3100, end: 4100, originalStart: 3100, originalEnd: 4100 },
        ];
        const media = createAdapter();
        const cueChanges: number[] = [];

        const controller = new PrimingController({
            settings: {
                ...defaultPrimingSettings,
                passSequence: ['en', 'raw', 'jp'],
                autoAdvance: false,
                interPassGapMs: 0,
            },
            subtitles: () => bilingual,
            media,
            onCueChanged: (index) => cueChanges.push(index),
        });

        controller.start();
        await new Promise((resolve) => setTimeout(resolve, 50));
        controller.skipToNextCue();
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(cueChanges[0]).toBe(1);
        expect(cueChanges.at(-1)).toBe(3);
        controller.stop();
    });

    it('resumes the current pass after a user pause without advancing', async () => {
        const pauseHandlers: Array<() => void> = [];
        const playHandlers: Array<() => void> = [];
        let timeMs = 1500;
        let releaseWait: ((reached: boolean) => void) | undefined;

        const media = createAdapter({
            currentTimeMs: () => timeMs,
            seek: jest.fn(async (timestampMs: number) => {
                timeMs = timestampMs;
            }),
            waitUntilTime: jest.fn(
                () =>
                    new Promise<boolean>((resolve) => {
                        releaseWait = resolve;
                    })
            ),
            cancelPendingWait: jest.fn(() => {
                releaseWait?.(false);
            }),
            onExternalPause: (cb) => {
                pauseHandlers.push(cb);
                return () => {
                    const index = pauseHandlers.indexOf(cb);
                    if (index >= 0) pauseHandlers.splice(index, 1);
                };
            },
            onExternalPlay: (cb) => {
                playHandlers.push(cb);
                return () => {
                    const index = playHandlers.indexOf(cb);
                    if (index >= 0) playHandlers.splice(index, 1);
                };
            },
        });
        const passChanges: number[] = [];
        media.setVisibleTracks = jest.fn((indices: readonly number[]) => {
            void indices;
        });

        const controller = new PrimingController({
            settings: {
                ...defaultPrimingSettings,
                passSequence: ['en', 'jp'],
                autoAdvance: false,
                interPassGapMs: 0,
            },
            subtitles: () => subtitles,
            media,
            onPassChanged: (index) => passChanges.push(index),
        });

        controller.start();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(passChanges).toEqual([0]);

        for (const handler of pauseHandlers) handler();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(passChanges).toEqual([0]);

        for (const handler of playHandlers) handler();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(passChanges.at(-1)).toBe(0);
        expect(media.seek).toHaveBeenCalledTimes(1);
        controller.stop();
    });
});
