import { describe, expect, it } from '@jest/globals';
import PrimingSupport from '@project/common/app/services/priming-support';
import type { PrimingContext } from '@project/common/app/services/priming-support';
import { defaultPrimingSettings } from '@project/common/settings/settings';

type WaitUntilTime = (video: HTMLVideoElement, targetMs: number) => Promise<boolean>;

function setup(startMs: number) {
    const state = { timeMs: startMs };
    const video = document.createElement('video');
    const context: PrimingContext = {
        video,
        currentTimeMs: () => state.timeMs,
        seek: async () => undefined,
        play: async () => undefined,
        pause: () => undefined,
        subtitles: () => [],
        subtitleFileNames: () => [],
        setVisibleTracks: () => undefined,
        clearPrimingTrackVisibility: () => undefined,
        resetDisabledSubtitleTracks: () => undefined,
        getPrimingSettings: () => defaultPrimingSettings,
    };
    const support = new PrimingSupport(context);
    const waitUntilTime = (support as unknown as { waitUntilTime: WaitUntilTime }).waitUntilTime.bind(support);
    const outcome = (promise: Promise<boolean>) =>
        Promise.race([promise, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 120))]);
    return { state, video, support, waitUntilTime, outcome };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('PrimingSupport waitUntilTime', () => {
    it('resolves when playback runs through the target', async () => {
        const { state, video, waitUntilTime, outcome } = setup(4900);
        const wait = waitUntilTime(video, 5000);
        await sleep(30);
        state.timeMs = 5010;
        expect(await outcome(wait)).toBe(true);
    });

    it('does not treat a scrub far past the target as the pass finishing', async () => {
        const { state, video, support, waitUntilTime, outcome } = setup(3000);
        const wait = waitUntilTime(video, 5000);
        await sleep(30);
        state.timeMs = 60000; // user dragged the progress bar to the middle of the video
        expect(await outcome(wait)).toBe('pending');
        support.destroy();
        expect(await outcome(wait)).toBe(false);
    });
});
