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
    /** Short visual cue that playback is rewinding to replay the drill. */
    flashRewind?(): void;
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

interface DrillGroup {
    readonly cues: readonly IndexedSubtitleModel[];
    readonly start: number;
    readonly end: number;
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
        this.onCueChanged?.(found.group.cues[0].index);
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
        if (this.groupAt(this.listIndex) === undefined) {
            this.stop();
            return;
        }

        const target = this.nextStartIndex(this.listIndex);
        if (target >= cues.length) {
            this.stop();
            return;
        }

        this.goToStart(target, cues);
    }

    skipToPreviousCue(): void {
        if (!this.active) return;
        if (this.listIndex <= 0) return;

        const cues = this.drillCues();
        const target = this.previousStartIndex(this.listIndex);
        if (target < 0) return;

        this.goToStart(target, cues);
    }

    extendCurrentGap(extraMs: number): void {
        if (!this.active) return;
        this.gapExtensionMs += extraMs;
    }

    /**
     * Pause the drill loop without tearing it down — used while mining/recording so a seek
     * to the mined cue does not restart the current multi-line group from its first line.
     * Stays suspended until external play or navigation; mining must not auto-restart playback.
     */
    suspendForExternalMediaControl(): void {
        if (!this.active) return;
        this.suspended = true;
        this.cancelSleep();
        this.media.cancelPendingWait();
    }

    updateSettings(settings: PrimingSettings): void {
        const sequenceChanged = JSON.stringify(this.settings.passSequence) !== JSON.stringify(settings.passSequence);
        const linesChanged =
            this.settings.linesPerDrill !== settings.linesPerDrill ||
            (this.settings.drillSeconds ?? 0) !== (settings.drillSeconds ?? 0);
        this.settings = settings;
        if (this.active && (sequenceChanged || linesChanged)) {
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
                if (!this.active || this.cancelled || this.suspended) return;
                const found = this.cueContaining(timestampMs);
                if (found === undefined) return;
                this.listIndex = found.listIndex;
                this.passIndex = 0;
                this.gapExtensionMs = 0;
                this.onCueChanged?.(found.group.cues[0].index);
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

            const group = this.groupAt(this.listIndex);
            if (group === undefined) {
                this.stop();
                return;
            }

            const sequence = this.settings.passSequence ?? [];
            const passCount = sequence.length > 0 ? sequence.length : this.settings.passes.length;
            while (this.passIndex < passCount) {
                if (!this.active || this.cancelled) return;
                if (this.suspended) break;

                const pass = this.timingForPass(this.passIndex, passCount);

                const durationMs = this.media.durationMs();
                const startMs = group.start;
                const endMs =
                    Number.isFinite(durationMs) && durationMs > 0 ? Math.min(durationMs, group.end) : group.end;

                const nowMs = this.media.currentTimeMs();
                const resumeMidPass = this.pausedMidPass && nowMs >= startMs && nowMs < endMs;
                this.pausedMidPass = false;
                const replayPass = this.passIndex > 0;

                if (!resumeMidPass && replayPass) {
                    if (this.settings.rewindFlash ?? true) this.media.flashRewind?.();
                    await this.media.seek(startMs);
                }

                this.media.setVisibleTracks(this.visibleTracksForCurrentPass());
                this.onPassChanged?.(this.passIndex);
                this.media.setBlackout(pass.blackout);
                this.media.setPlaybackRate(pass.playbackRate);

                if (!resumeMidPass && !replayPass) {
                    await this.media.seek(startMs);
                }
                if (!this.active || this.cancelled) return;
                await this.media.play();
                if (!this.active || this.cancelled) return;

                const passCompleted = await this.media.waitUntilTime(endMs);
                if (!this.active || this.cancelled) return;
                if (!passCompleted || this.suspended) break;

                this.media.pause();

                const isLastPass = this.passIndex >= passCount - 1;
                const gap = isLastPass
                    ? 0
                    : Math.max(0, this.settings.interPassGapMs ?? pass.gapMs) + this.gapExtensionMs;
                this.gapExtensionMs = 0;
                if (gap > 0) {
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
        const target = this.listIndex + this.groupSize(this.listIndex, cues);
        if (target >= cues.length) {
            this.stop();
            return false;
        }

        this.listIndex = target;
        this.passIndex = 0;
        this.onCueChanged?.(cues[this.listIndex].index);
        return true;
    }

    private goToStart(listIndex: number, cues: readonly IndexedSubtitleModel[]): void {
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

    private linesPerDrill(): number {
        return Math.max(1, Math.floor(this.settings.linesPerDrill ?? 1));
    }

    private navigateByLine(): boolean {
        return this.settings.navigateByLine ?? true;
    }

    private drillWindowMs(): number {
        const seconds = this.settings.drillSeconds ?? 0;
        return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
    }

    /**
     * Number of cues in the drill group starting at startIndex. In time mode, every cue that starts
     * inside the window is included and played to its end, so a line is never cut in half.
     */
    private groupSize(startIndex: number, cues: readonly IndexedSubtitleModel[]): number {
        const windowMs = this.drillWindowMs();
        if (windowMs <= 0) return this.linesPerDrill();
        const first = cues[startIndex];
        if (first === undefined) return 1;
        let end = startIndex + 1;
        while (end < cues.length && cues[end].start < first.start + windowMs) {
            end += 1;
        }
        return end - startIndex;
    }

    private navigationStep(): number {
        if (this.navigateByLine()) return 1;
        if (this.drillWindowMs() > 0) return this.groupSize(this.listIndex, this.drillCues());
        return this.linesPerDrill();
    }

    private groupAt(startIndex: number): DrillGroup | undefined {
        const cues = this.drillCues();
        if (startIndex < 0 || startIndex >= cues.length) return undefined;
        const slice = cues.slice(startIndex, startIndex + this.groupSize(startIndex, cues));
        return {
            cues: slice,
            start: slice[0].start,
            end: slice[slice.length - 1].end,
        };
    }

    private nextStartIndex(currentIndex: number): number {
        const step = this.navigationStep();
        if (step === 1) {
            const cues = this.drillCues();
            const current = cues[currentIndex];
            if (current === undefined) return currentIndex + 1;

            let target = currentIndex + 1;
            while (target < cues.length && cuesOverlap(current, cues[target])) {
                target += 1;
            }
            return target;
        }

        return currentIndex + step;
    }

    private previousStartIndex(currentIndex: number): number {
        const step = this.navigationStep();
        if (step === 1) {
            const cues = this.drillCues();
            const current = cues[currentIndex];
            if (current === undefined || currentIndex <= 0) return currentIndex - 1;

            let target = currentIndex - 1;
            while (target >= 0 && cuesOverlap(current, cues[target])) {
                target -= 1;
            }
            return target;
        }

        if (this.drillWindowMs() > 0) return this.previousWindowStartIndex(currentIndex);
        return currentIndex - step;
    }

    /** Earliest start index whose time window would end right before currentIndex. */
    private previousWindowStartIndex(currentIndex: number): number {
        const cues = this.drillCues();
        let target = currentIndex - 1;
        while (target > 0 && target - 1 + this.groupSize(target - 1, cues) <= currentIndex) {
            target -= 1;
        }
        return target;
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

    private cueAtPlayhead(): { listIndex: number; group: DrillGroup } | undefined {
        return this.cueContaining(this.media.currentTimeMs());
    }

    private cueContaining(timestampMs: number): { listIndex: number; group: DrillGroup } | undefined {
        const cues = this.drillCues();
        const containing = cues.findIndex((cue) => timestampMs >= cue.start && timestampMs <= cue.end);
        const rawIndex = containing >= 0 ? containing : this.nearestCueIndex(cues, timestampMs);
        if (rawIndex < 0) return undefined;

        const listIndex = this.alignStartIndex(rawIndex);
        const group = this.groupAt(listIndex);
        if (group === undefined) return undefined;
        return { listIndex, group };
    }

    private alignStartIndex(index: number): number {
        const step = this.linesPerDrill();
        if (this.navigateByLine() || this.drillWindowMs() > 0 || step <= 1) return index;
        return Math.floor(index / step) * step;
    }

    private nearestCueIndex(cues: readonly IndexedSubtitleModel[], timestampMs: number): number {
        let bestIndex = -1;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let i = 0; i < cues.length; ++i) {
            const cue = cues[i];
            const distance =
                timestampMs < cue.start ? cue.start - timestampMs : timestampMs > cue.end ? timestampMs - cue.end : 0;
            if (distance < bestDistance) {
                bestDistance = distance;
                bestIndex = i;
            }
        }
        return bestIndex;
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
