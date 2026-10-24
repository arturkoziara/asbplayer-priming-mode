import { describe, expect, it, jest } from '@jest/globals';
import type { IndexedSubtitleModel } from '@project/common';
import { defaultPrimingSettings } from '@project/common/settings/settings';
import PrimingController, { type MediaAdapter } from './priming-controller';

function sequentialCues(count: number): IndexedSubtitleModel[] {
    return Array.from({ length: count }, (_, index) => ({
        index,
        text: `line ${index}`,
        start: 1000 + index * 1500,
        end: 2000 + index * 1500,
        originalStart: 1000 + index * 1500,
        originalEnd: 2000 + index * 1500,
        track: 0,
        displayTime: `00:0${index}`,
    }));
}

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
    it('sets visibility before seek on the first pass of each cue', async () => {
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
        const firstVisible = order.indexOf('visible');
        const firstSeek = order.indexOf('seek');
        expect(firstVisible).toBeGreaterThanOrEqual(0);
        expect(firstSeek).toBeGreaterThan(firstVisible);
        controller.stop();
    });

    it('seeks before changing visibility when replaying the same cue on a later pass', async () => {
        const media = createAdapter();
        const order: string[] = [];
        media.setVisibleTracks = jest.fn(() => order.push('visible'));
        media.seek = jest.fn(async (timestampMs: number) => {
            order.push(`seek:${timestampMs}`);
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
        await new Promise((resolve) => setTimeout(resolve, 80));
        const secondSeek = order.indexOf('seek:1000', order.indexOf('seek:1000') + 1);
        const secondVisible = order.indexOf('visible', order.indexOf('visible') + 1);
        expect(secondSeek).toBeGreaterThanOrEqual(0);
        expect(secondVisible).toBeGreaterThan(secondSeek);
        controller.stop();
    });

    it('ends each pass at the exact cue end even when postrollMs is configured', async () => {
        const media = createAdapter();
        const endTimes: number[] = [];
        media.waitUntilTime = jest.fn(async (targetMs: number) => {
            endTimes.push(targetMs);
            return true;
        });

        const controller = new PrimingController({
            settings: {
                ...defaultPrimingSettings,
                postrollMs: 300,
                passSequence: ['en'],
                autoAdvance: false,
                interPassGapMs: 0,
            },
            subtitles: () => subtitles,
            media,
        });

        controller.start();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(endTimes[0]).toBe(2000);
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

    it('seeks to exact cue start even when prerollMs is configured', async () => {
        const media = createAdapter();
        const controller = new PrimingController({
            settings: {
                ...defaultPrimingSettings,
                prerollMs: 200,
                passSequence: ['en'],
                autoAdvance: false,
                interPassGapMs: 0,
            },
            subtitles: () => subtitles,
            media,
        });

        controller.start();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(media.seek).toHaveBeenCalledWith(1000);
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
            {
                ...subtitles[0],
                index: 1,
                text: 'こんにちは',
                track: 1,
                start: 1100,
                end: 2100,
                originalStart: 1100,
                originalEnd: 2100,
            },
            { ...subtitles[1], index: 2, track: 0, start: 3000, end: 4000, originalStart: 3000, originalEnd: 4000 },
            {
                ...subtitles[1],
                index: 3,
                text: '世界',
                track: 1,
                start: 3100,
                end: 4100,
                originalStart: 3100,
                originalEnd: 4100,
            },
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

    it('plays multiple consecutive lines when linesPerDrill is greater than one', async () => {
        const threeLines: IndexedSubtitleModel[] = [
            { ...subtitles[0], index: 0, start: 1000, end: 2000, originalStart: 1000, originalEnd: 2000 },
            {
                ...subtitles[0],
                index: 1,
                text: 'again',
                start: 2500,
                end: 3500,
                originalStart: 2500,
                originalEnd: 3500,
            },
            { ...subtitles[1], index: 2, start: 4000, end: 5000, originalStart: 4000, originalEnd: 5000 },
        ];
        const media = createAdapter();
        const endTimes: number[] = [];
        media.waitUntilTime = jest.fn(async (targetMs: number) => {
            endTimes.push(targetMs);
            return true;
        });

        const controller = new PrimingController({
            settings: {
                ...defaultPrimingSettings,
                passSequence: ['en'],
                linesPerDrill: 2,
                postrollMs: 0,
                prerollMs: 0,
                autoAdvance: false,
                interPassGapMs: 0,
            },
            subtitles: () => threeLines,
            media,
        });

        controller.start();
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(endTimes[0]).toBe(3500);
        controller.stop();
    });

    it('drills by time and always finishes the last line that starts inside the window', async () => {
        // Cues start every 1.5s and last 1s: 1000-2000, 2500-3500, 4000-5000, 5500-6500, ...
        const cues = sequentialCues(8);
        const media = createAdapter();
        const seeks: number[] = [];
        const endTimes: number[] = [];
        media.seek = jest.fn(async (timestampMs: number) => {
            seeks.push(timestampMs);
        });
        media.waitUntilTime = jest.fn(async (targetMs: number) => {
            endTimes.push(targetMs);
            return true;
        });

        const controller = new PrimingController({
            settings: {
                ...defaultPrimingSettings,
                passSequence: ['en'],
                linesPerDrill: 1,
                drillSeconds: 4,
                prerollMs: 0,
                postrollMs: 0,
                autoAdvance: true,
                stopAfterCues: 2,
                interPassGapMs: 0,
            },
            subtitles: () => cues,
            media,
        });

        controller.start();
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Window 1000-5000 contains starts 1000, 2500, 4000 -> ends at the third line's end, 5000.
        // Next group starts at the fourth line (5500); window 5500-9500 has starts 5500, 7000, 8500 -> 9500.
        expect(seeks).toEqual([1000, 5500]);
        expect(endTimes).toEqual([5000, 9500]);
        expect(controller.running).toBe(false);
    });

    it('flashes and ticks only when rewinding to replay, following the settings', async () => {
        const run = async (settings: { rewindFlash: boolean; rewindFlashIntensity: number; rewindSound: boolean }) => {
            const flashRewind = jest.fn((_opacity: number) => undefined);
            const playRewindSound = jest.fn(() => undefined);
            const media = createAdapter({ flashRewind, playRewindSound });
            const controller = new PrimingController({
                settings: {
                    ...defaultPrimingSettings,
                    passSequence: ['en', 'raw', 'jp'],
                    autoAdvance: false,
                    interPassGapMs: 0,
                    ...settings,
                },
                subtitles: () => subtitles,
                media,
            });
            controller.start();
            await new Promise((resolve) => setTimeout(resolve, 50));
            controller.stop();
            return {
                flashes: flashRewind.mock.calls.map(([opacity]) => opacity),
                sounds: playRewindSound.mock.calls.length,
            };
        };

        // Three passes: the first plays straight in, the next two rewind.
        expect(await run({ rewindFlash: true, rewindFlashIntensity: 40, rewindSound: false })).toEqual({
            flashes: [0.4, 0.4],
            sounds: 0,
        });
        expect(await run({ rewindFlash: false, rewindFlashIntensity: 40, rewindSound: true })).toEqual({
            flashes: [],
            sounds: 2,
        });
    });

    it('keeps a single long line whole when it is longer than the time window', async () => {
        const longLine: IndexedSubtitleModel[] = [
            { ...subtitles[0], index: 0, start: 1000, end: 9000, originalStart: 1000, originalEnd: 9000 },
            { ...subtitles[1], index: 1, start: 9500, end: 10000, originalStart: 9500, originalEnd: 10000 },
        ];
        const media = createAdapter();
        const endTimes: number[] = [];
        media.waitUntilTime = jest.fn(async (targetMs: number) => {
            endTimes.push(targetMs);
            return true;
        });

        const controller = new PrimingController({
            settings: {
                ...defaultPrimingSettings,
                passSequence: ['en'],
                drillSeconds: 3,
                autoAdvance: false,
                interPassGapMs: 0,
            },
            subtitles: () => longLine,
            media,
        });

        controller.start();
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(endTimes[0]).toBe(9000);
        controller.stop();
    });

    it('skipToNextCue steps one line when navigateByLine is on in a multi-line drill', async () => {
        const sixLines = sequentialCues(6);
        const media = createAdapter();
        const cueChanges: number[] = [];

        const controller = new PrimingController({
            settings: {
                ...defaultPrimingSettings,
                passSequence: ['en'],
                linesPerDrill: 4,
                navigateByLine: true,
                autoAdvance: false,
                interPassGapMs: 0,
            },
            subtitles: () => sixLines,
            media,
            onCueChanged: (index) => cueChanges.push(index),
        });

        controller.start();
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.skipToNextCue();
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.skipToNextCue();
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.skipToPreviousCue();
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(cueChanges).toEqual([0, 1, 2, 1]);
        controller.stop();
    });

    it('skipToNextCue still jumps a full drill group when navigateByLine is off', async () => {
        const sixLines = sequentialCues(6);
        const media = createAdapter();
        const cueChanges: number[] = [];

        const controller = new PrimingController({
            settings: {
                ...defaultPrimingSettings,
                passSequence: ['en'],
                linesPerDrill: 4,
                navigateByLine: false,
                autoAdvance: false,
                interPassGapMs: 0,
            },
            subtitles: () => sixLines,
            media,
            onCueChanged: (index) => cueChanges.push(index),
        });

        controller.start();
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.skipToNextCue();
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.skipToPreviousCue();
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(cueChanges).toEqual([0, 4, 0]);
        controller.stop();
    });

    it('plays a sliding four-line window after stepping one line', async () => {
        const sixLines = sequentialCues(6);
        const media = createAdapter();
        const endTimes: number[] = [];
        media.waitUntilTime = jest.fn(async (targetMs: number) => {
            endTimes.push(targetMs);
            return true;
        });

        const controller = new PrimingController({
            settings: {
                ...defaultPrimingSettings,
                passSequence: ['en'],
                linesPerDrill: 4,
                navigateByLine: true,
                autoAdvance: false,
                interPassGapMs: 0,
            },
            subtitles: () => sixLines,
            media,
        });

        controller.start();
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.skipToNextCue();
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(endTimes.at(-1)).toBe(sixLines[4].end);
        controller.stop();
    });

    it('does not restart a multi-line group when suspended for mining seek', async () => {
        const threeLines: IndexedSubtitleModel[] = [
            { ...subtitles[0], index: 0, start: 1000, end: 2000, originalStart: 1000, originalEnd: 2000 },
            {
                ...subtitles[0],
                index: 1,
                text: 'again',
                start: 2500,
                end: 3500,
                originalStart: 2500,
                originalEnd: 3500,
            },
            { ...subtitles[1], index: 2, start: 4000, end: 5000, originalStart: 4000, originalEnd: 5000 },
        ];

        const seekHandlers: Array<(t: number) => void> = [];
        let timeMs = 2800;
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
            onExternalSeek: (cb) => {
                seekHandlers.push(cb);
                return () => {
                    const index = seekHandlers.indexOf(cb);
                    if (index >= 0) seekHandlers.splice(index, 1);
                };
            },
        });

        const controller = new PrimingController({
            settings: {
                ...defaultPrimingSettings,
                passSequence: ['en'],
                linesPerDrill: 3,
                postrollMs: 0,
                prerollMs: 0,
                autoAdvance: false,
                interPassGapMs: 0,
            },
            subtitles: () => threeLines,
            media,
        });

        controller.start();
        await new Promise((resolve) => setTimeout(resolve, 20));
        const seeksBeforeMine = (media.seek as jest.Mock).mock.calls.length;

        // Simulate mining mid-group (line 2 of 3): suspend then seek to that line's start.
        controller.suspendForExternalMediaControl();
        timeMs = 2500;
        for (const handler of seekHandlers) handler(2500);
        await new Promise((resolve) => setTimeout(resolve, 20));

        // Must not restart from group start after the mining seek.
        const seeksAfterMine = (media.seek as jest.Mock).mock.calls.length;
        expect(seeksAfterMine).toBe(seeksBeforeMine);
        controller.stop();
    });

    describe('resuming after mining', () => {
        // One 10s window (three lines, 1000-5000) drilled EN then JP.
        const threeLines: IndexedSubtitleModel[] = [
            { ...subtitles[0], index: 0, start: 1000, end: 2000, originalStart: 1000, originalEnd: 2000 },
            { ...subtitles[0], index: 1, start: 2500, end: 3500, originalStart: 2500, originalEnd: 3500 },
            { ...subtitles[1], index: 2, start: 4000, end: 5000, originalStart: 4000, originalEnd: 5000 },
        ];

        function setup() {
            const playHandlers: Array<() => void> = [];
            const state = { timeMs: 1000 };
            const seeks: number[] = [];
            const waits: number[] = [];
            let releaseWait: ((reached: boolean) => void) | undefined;
            const media = createAdapter({
                currentTimeMs: () => state.timeMs,
                seek: jest.fn(async (timestampMs: number) => {
                    seeks.push(timestampMs);
                    state.timeMs = timestampMs;
                }),
                waitUntilTime: jest.fn((targetMs: number) => {
                    waits.push(targetMs);
                    return new Promise<boolean>((resolve) => {
                        releaseWait = resolve;
                    });
                }),
                cancelPendingWait: jest.fn(() => releaseWait?.(false)),
                onExternalPlay: (cb) => {
                    playHandlers.push(cb);
                    return () => undefined;
                },
            });
            const controller = new PrimingController({
                settings: {
                    ...defaultPrimingSettings,
                    passSequence: ['en', 'jp'],
                    linesPerDrill: 3,
                    autoAdvance: false,
                    interPassGapMs: 0,
                },
                subtitles: () => threeLines,
                media,
            });
            const tick = () => new Promise((resolve) => setTimeout(resolve, 150));
            const mineAndResume = async (playheadAfterMine: number) => {
                controller.suspendForExternalMediaControl();
                state.timeMs = playheadAfterMine;
                await tick();
                for (const handler of playHandlers) handler();
                await tick();
            };
            return { controller, seeks, waits, tick, mineAndResume };
        }

        it('continues from the mined line instead of rewinding to the window start', async () => {
            const { controller, seeks, waits, tick, mineAndResume } = setup();
            controller.start();
            await tick();
            expect(seeks).toEqual([1000]);

            // Mine the middle line; recording leaves the playhead at its end.
            await mineAndResume(3600);

            expect(seeks).toEqual([1000]);
            expect(waits).toEqual([5000, 5000]);
            expect(controller.currentPassIndex).toBe(0);
            controller.stop();
        });

        it('moves on to the next pass when mining ran past the end of the window', async () => {
            const { controller, seeks, tick, mineAndResume } = setup();
            controller.start();
            await tick();

            // Mine the last line; recording padding carries the playhead past the window end.
            await mineAndResume(5200);

            expect(controller.currentPassIndex).toBe(1);
            expect(seeks).toEqual([1000, 1000]);
            controller.stop();
        });
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
