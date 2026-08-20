import type { IndexedSubtitleModel } from '@project/common';
import type { PrimingPass, PrimingSettings } from '@project/common/settings/settings';
import {
    preferredDrillTrack,
    visibleTracksForPass,
    type PrimingTrackKind,
} from '@project/common/playback/controllers/priming-pass-sequence';

export interface MediaAdapter {
    currentTimeMs(): number;
    durationMs(): number;
    seek(timestampMs: number): Promise<void>;
    play(): Promise<void>;
    pause(): void;
    setPlaybackRate(rate: number): void;
    setVisibleTracks(indices: readonly number[]): void;
    setBlackout(on: boolean): void;
    waitUntilTime(targetMs: number): Promise<boolean>;
    cancelPendingWait(): void;
    trackKinds(): ReadonlyMap<number, PrimingTrackKind>;
    onExternalSeek(cb: (timestampMs: number) => void): () => void;
    onExternalPause(cb: () => void): () => void;
    onExternalPlay(cb: () => void): () => void;
    onVisibilityHidden(cb: () => void): () => void;
    onVisibilityVisible(cb: () => void): () => void;
}

export interface PrimingControllerOptions {
    readonly settings: PrimingSettings;
    readonly subtitles: () => readonly IndexedSubtitleModel[];
    readonly media: MediaAdapter;
    readonly onCueChanged?: (cueIndex: number) => void;
    readonly onPassChanged?: (passIndex: number) => void;
}

export default class PrimingController {
    private settings: PrimingSettings;
    private readonly subtitles: () => readonly IndexedSubtitleModel[];
    private readonly media: MediaAdapter;
    private readonly onCueChanged?: (cueIndex: number) => void;
    private readonly onPassChanged?: (passIndex: number) => void;
    private readonly unbinders: Array<() => void> = [];

    private active = false;
    private cancelled = false;
    private suspended = false;
    private listIndex = -1;
    private passIndex = 0;
    private gapExtensionMs = 0;
    private cuesDrilled = 0;
    private runPromise: Promise<void> | undefined;
    private sleepTimer?: ReturnType<typeof setTimeout>;
    private sleepResolve?: () => void;
    private pausedMidPass = false;

    constructor(options: PrimingControllerOptions) {
        this.settings = options.settings;
        this.subtitles = options.subtitles;
        this.media = options.media;
        this.onCueChanged = options.onCueChanged;
        this.onPassChanged = options.onPassChanged;
    }

    get running(): boolean {
        return this.active;
    }

    get currentPassIndex(): number {
        return this.passIndex;
    }

    get passCount(): number {
        const sequence = this.settings.passSequence ?? [];
        return sequence.length > 0 ? sequence.length : this.settings.passes.length;
    }

    start(): void {
        if (this.active) return;
        this.active = true;
        this.cancelled = false;
        this.suspended = false;
        this.gapExtensionMs = 0;
        this.cuesDrilled = 0;
        this.passIndex = 0;

        const found = this.cueAtPlayhead();
        if (found === undefined) {
            this.active = false;
            return;
        }

        this.listIndex = found.listIndex;
        this.onCueChanged?.(found.cue.index);
        this.bindInterruptionHandlers();
        this.runPromise = this.runFromCurrentPass();
    }

    stop(pause = true): void {
        if (!this.active) return;
        this.cancelled = true;
        this.active = false;
        this.cancelSleep();
        this.media.cancelPendingWait();
        this.unbindInterruptionHandlers();
        this.media.setBlackout(false);
        this.media.setVisibleTracks([...this.media.trackKinds().keys()]);
        if (pause) this.media.pause();
    }

    repeatCurrentCue(): void {
        if (!this.active) return;
        this.passIndex = 0;
        this.gapExtensionMs = 0;
        void this.restartRun();
    }

    skipCurrentPass(): void {
        if (!this.active) return;
        this.gapExtensionMs = 0;
        this.passIndex += 1;
        void this.restartRun();
    }

    skipToNextCue(): void {
        if (!this.active) return;

        const cues = this.drillCues();
        const current = cues[this.listIndex];
        if (current === undefined) {
            this.stop();
            return;
        }

        let target = this.listIndex + 1;
        while (target < cues.length && cuesOverlap(current, cues[target])) {
            target += 1;
        }

        if (target >= cues.length) {
            this.stop();
            return;
        }

        this.goToCue(target, cues);
    }

    skipToPreviousCue(): void {
        if (!this.active) return;

        const cues = this.drillCues();
        const current = cues[this.listIndex];
        if (current === undefined || this.listIndex <= 0) return;

        let target = this.listIndex - 1;
        while (target >= 0 && cuesOverlap(current, cues[target])) {
            target -= 1;
        }

        if (target < 0) return;

        this.goToCue(target, cues);
    }

    extendCurrentGap(extraMs: number): void {
        if (!this.active) return;
        this.gapExtensionMs += extraMs;
    }

    updateSettings(settings: PrimingSettings): void {
        const sequenceChanged = JSON.stringify(this.settings.passSequence) !== JSON.stringify(settings.passSequence);
        this.settings = settings;
        if (this.active && sequenceChanged) {
            this.passIndex = 0;
            void this.restartRun();
        }
    }

    private async restartRun(): Promise<void> {
        this.cancelled = true;
        this.cancelSleep();
        this.media.cancelPendingWait();
        await this.runPromise;
        if (!this.active) return;
        this.cancelled = false;
        this.runPromise = this.runFromCurrentPass();
    }

    private cancelSleep(): void {
        if (this.sleepTimer !== undefined) {
            clearTimeout(this.sleepTimer);
            this.sleepTimer = undefined;
        }
        if (this.sleepResolve) {
            this.sleepResolve();
            this.sleepResolve = undefined;
        }
    }

    private sleep(ms: number): Promise<void> {
        if (ms <= 0) return Promise.resolve();
        return new Promise((resolve) => {
            this.sleepResolve = resolve;
            this.sleepTimer = setTimeout(() => {
                this.sleepTimer = undefined;
                this.sleepResolve = undefined;
                resolve();
            }, ms);
        });
    }

    private bindInterruptionHandlers(): void {
        this.unbinders.push(
            this.media.onExternalSeek((timestampMs) => {
                if (!this.active || this.cancelled) return;
                const found = this.cueContaining(timestampMs);
                if (found === undefined) return;
                this.listIndex = found.listIndex;
                this.passIndex = 0;
                this.gapExtensionMs = 0;
                this.onCueChanged?.(found.cue.index);
                void this.restartRun();
            }),
            this.media.onExternalPause(() => {
                if (!this.active || this.cancelled) return;
                this.suspended = true;
                this.pausedMidPass = true;
                this.cancelSleep();
                this.media.cancelPendingWait();
            }),
            this.media.onExternalPlay(() => {
                if (!this.active || this.cancelled || !this.suspended) return;
                this.suspended = false;
            }),
            this.media.onVisibilityHidden(() => {
                if (!this.active) return;
                this.suspended = true;
                this.media.pause();
            }),
            this.media.onVisibilityVisible(() => {
                if (!this.active || !this.suspended) return;
                this.suspended = false;
                void this.restartRun();
            })
        );
    }

    private unbindInterruptionHandlers(): void {
        for (const unbind of this.unbinders) unbind();
        this.unbinders.length = 0;
    }

    private async runFromCurrentPass(): Promise<void> {
        while (this.active && !this.cancelled) {
            if (this.suspended) {
                await this.sleep(100);
                continue;
            }

            const cue = this.drillCues()[this.listIndex];
            if (cue === undefined) {
                this.stop();
                return;
            }

            const sequence = this.settings.passSequence ?? [];
            const passCount = sequence.length > 0 ? sequence.length : this.settings.passes.length;
            while (this.passIndex < passCount) {
                if (!this.active || this.cancelled) return;
                if (this.suspended) break;

                const pass = this.timingForPass(this.passIndex, passCount);
                this.media.setVisibleTracks(this.visibleTracksForCurrentPass());
                this.onPassChanged?.(this.passIndex);
                this.media.setBlackout(pass.blackout);
                this.media.setPlaybackRate(pass.playbackRate);

                const durationMs = this.media.durationMs();
                const startMs = Math.max(0, cue.start - this.settings.prerollMs);
                const endMs =
                    Number.isFinite(durationMs) && durationMs > 0
                        ? Math.min(durationMs, cue.end + this.settings.postrollMs)
                        : cue.end + this.settings.postrollMs;

                const nowMs = this.media.currentTimeMs();
                const resumeMidPass = this.pausedMidPass && nowMs >= startMs && nowMs < endMs;
                this.pausedMidPass = false;

                if (!resumeMidPass) {
                    await this.media.seek(startMs);
                }
                if (!this.active || this.cancelled) return;
                await this.media.play();
                if (!this.active || this.cancelled) return;

                const passCompleted = await this.media.waitUntilTime(endMs);
                if (!this.active || this.cancelled) return;
                if (!passCompleted || this.suspended) break;

                const isLastPass = this.passIndex >= passCount - 1;
                const gap = isLastPass
                    ? 0
                    : Math.max(0, this.settings.interPassGapMs ?? pass.gapMs) + this.gapExtensionMs;
                this.gapExtensionMs = 0;
                if (gap > 0) {
                    this.media.pause();
                    await this.sleep(gap);
                    if (this.suspended) break;
                }

                this.passIndex += 1;
            }

            if (this.suspended) continue;

            this.passIndex = 0;
            this.cuesDrilled += 1;
            if (this.settings.stopAfterCues > 0 && this.cuesDrilled >= this.settings.stopAfterCues) {
                this.stop();
                return;
            }

            if (!(await this.advanceCue())) return;
        }
    }

    private async advanceCue(): Promise<boolean> {
        if (!this.settings.autoAdvance) {
            this.suspended = true;
            return false;
        }

        const cues = this.drillCues();
        const current = cues[this.listIndex];
        if (current === undefined) {
            this.stop();
            return false;
        }

        let target = this.listIndex + 1;
        while (target < cues.length && cuesOverlap(current, cues[target])) {
            target += 1;
        }

        if (target >= cues.length) {
            this.stop();
            return false;
        }

        this.listIndex = target;
        this.passIndex = 0;
        this.onCueChanged?.(cues[this.listIndex].index);
        return true;
    }

    private goToCue(listIndex: number, cues: readonly IndexedSubtitleModel[]): void {
        this.listIndex = listIndex;
        this.passIndex = 0;
        this.gapExtensionMs = 0;
        this.suspended = false;
        this.onCueChanged?.(cues[listIndex].index);
        void this.restartRun();
    }

    /** One timeline of cues: overlapping EN+JP at the same time count as one line. */
    private drillCues(): IndexedSubtitleModel[] {
        const all = this.subtitles();
        const preferredTrack = preferredDrillTrack(this.media.trackKinds());
        const longEnough = all.filter((subtitle) => subtitle.end - subtitle.start >= this.settings.minCueDurationMs);
        return collapseOverlappingCues(longEnough, preferredTrack);
    }

    private visibleTracksForCurrentPass(): readonly number[] {
        const sequence = this.settings.passSequence ?? [];
        if (sequence.length > 0) {
            return visibleTracksForPass(sequence[this.passIndex], this.media.trackKinds());
        }
        return this.settings.passes[this.passIndex]?.visibleTracks ?? [];
    }

    private timingForPass(index: number, count: number): PrimingPass {
        const templates = this.settings.passes;
        const template =
            templates[Math.min(index, Math.max(0, templates.length - 1))] ??
            ({
                visibleTracks: [],
                playbackRate: 1,
                gapMs: 250,
                gapFactor: 0.5,
                blackout: false,
            } satisfies PrimingPass);
        const last = index === count - 1;
        return {
            ...template,
            gapMs: last ? 0 : template.gapMs,
            gapFactor: last ? 0 : template.gapFactor,
        };
    }

    private cueAtPlayhead(): { listIndex: number; cue: IndexedSubtitleModel } | undefined {
        return this.cueContaining(this.media.currentTimeMs());
    }

    private cueContaining(timestampMs: number): { listIndex: number; cue: IndexedSubtitleModel } | undefined {
        const cues = this.drillCues();
        const containing = cues.findIndex((subtitle) => timestampMs >= subtitle.start && timestampMs <= subtitle.end);
        if (containing >= 0) return { listIndex: containing, cue: cues[containing] };

        let bestIndex = -1;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let i = 0; i < cues.length; ++i) {
            const subtitle = cues[i];
            const distance =
                timestampMs < subtitle.start
                    ? subtitle.start - timestampMs
                    : timestampMs > subtitle.end
                      ? timestampMs - subtitle.end
                      : 0;
            if (distance < bestDistance) {
                bestDistance = distance;
                bestIndex = i;
            }
        }
        if (bestIndex < 0) return undefined;
        return { listIndex: bestIndex, cue: cues[bestIndex] };
    }
}

function cuesOverlap(left: IndexedSubtitleModel, right: IndexedSubtitleModel): boolean {
    return left.start < right.end && right.start < left.end;
}

function collapseOverlappingCues(
    cues: IndexedSubtitleModel[],
    preferredTrack: number | undefined
): IndexedSubtitleModel[] {
    const sorted = [...cues].sort(
        (left, right) => left.start - right.start || left.end - right.end || left.track - right.track
    );
    const collapsed: IndexedSubtitleModel[] = [];
    for (const cue of sorted) {
        const last = collapsed[collapsed.length - 1];
        if (last !== undefined && cuesOverlap(last, cue)) {
            if (preferredTrack !== undefined && cue.track === preferredTrack && last.track !== preferredTrack) {
                collapsed[collapsed.length - 1] = cue;
            }
            continue;
        }
        collapsed.push(cue);
    }
    return collapsed;
}
