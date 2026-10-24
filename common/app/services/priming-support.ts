import { PlayMode } from '@project/common';
import PrimingController, { type MediaAdapter } from '@project/common/playback/controllers/priming-controller';
import {
    buildPrimingTrackKinds,
    preferredDrillTrack,
} from '@project/common/playback/controllers/priming-pass-sequence';
import type { PlayModeTransition } from '@project/common/playback/controllers/playback-mode-controller';
import type { PrimingSettings } from '@project/common/settings/settings';
import type { IndexedSubtitleModel } from '@project/common';

export interface PrimingContext {
    readonly video: HTMLMediaElement;
    readonly currentTimeMs: () => number;
    readonly seek: (timestampMs: number) => Promise<void>;
    readonly play: () => Promise<void>;
    readonly pause: () => void;
    readonly subtitles: () => readonly IndexedSubtitleModel[];
    readonly subtitleFileNames: () => readonly string[];
    readonly setVisibleTracks: (indices: readonly number[]) => void;
    readonly clearPrimingTrackVisibility: () => void;
    readonly resetDisabledSubtitleTracks: () => void;
    readonly getPrimingSettings: () => PrimingSettings;
    readonly onPrimingStateChanged?: () => void;
}

export default class PrimingSupport {
    private controller?: PrimingController;
    private blackoutElement?: HTMLDivElement;
    private flashElement?: HTMLDivElement;
    private ignoreExternalUntil = 0;
    private waitGeneration = 0;
    private desired = false;
    /** True while audio/screenshot mining owns the media element. */
    private recordingSuppressed = false;

    constructor(private readonly context: PrimingContext) {}

    handlePlaybackModesChanged(transition: PlayModeTransition): void {
        if (transition.added.has(PlayMode.priming)) {
            this.desired = true;
            this.start();
        }
        if (transition.removed.has(PlayMode.priming)) {
            this.desired = false;
            this.stop();
        }
    }

    handleInitialModes(transition: PlayModeTransition): void {
        if (transition.modes.has(PlayMode.priming)) {
            this.desired = true;
            this.start();
        }
    }

    subtitlesChanged(): void {
        if (this.desired) {
            this.start();
        }
    }

    updateSettings(settings: PrimingSettings): void {
        this.controller?.updateSettings(settings);
    }

    repeatCue(): void {
        this.ensureController();
        this.controller?.repeatCurrentCue();
    }

    skipPass(): void {
        this.ensureController();
        this.controller?.skipCurrentPass();
    }

    skipToNextCue(): void {
        this.ensureController();
        this.controller?.skipToNextCue();
    }

    skipToPreviousCue(): void {
        this.ensureController();
        this.controller?.skipToPreviousCue();
    }

    private ensureController(): void {
        if (!this.desired || this.controller?.running) {
            return;
        }
        this.start();
    }

    extendGap(extraMs = 2000): void {
        this.controller?.extendCurrentGap(extraMs);
    }

    get running(): boolean {
        return this.controller?.running ?? false;
    }

    /** True while the controller is performing its own seek/play (ignore redirect logic). */
    get suppressSubtitleNavigationRedirect(): boolean {
        return this.ignoringExternal || this.recordingSuppressed;
    }

    /**
     * Suspend the priming drill while mining records audio. Without this, seeking to the
     * mined line inside a multi-line group is treated as an external seek and the drill
     * restarts from the first line — so the recorder captures the wrong cue.
     */
    suspendForRecording(): void {
        this.recordingSuppressed = true;
        this.cancelWait();
        this.controller?.suspendForExternalMediaControl();
    }

    resumeAfterRecording(): void {
        this.recordingSuppressed = false;
        // Controller stays suspended until the user plays or navigates; do not auto-seek.
    }

    get currentPassIndex(): number {
        return this.controller?.currentPassIndex ?? 0;
    }

    get passCount(): number {
        return this.controller?.passCount ?? this.context.getPrimingSettings().passSequence.length;
    }

    /** Prefer JP for mined sentence text while priming. */
    preferredMiningTrack(): number | undefined {
        return preferredDrillTrack(this.trackKinds());
    }

    stop(): void {
        this.cancelWait();
        this.controller?.stop(true);
        this.controller = undefined;
        this.hideBlackout();
        this.context.clearPrimingTrackVisibility();
    }

    destroy(): void {
        this.desired = false;
        this.stop();
        this.blackoutElement?.remove();
        this.blackoutElement = undefined;
        this.flashElement?.remove();
        this.flashElement = undefined;
    }

    private start(): void {
        this.cancelWait();
        this.controller?.stop(false);
        this.context.resetDisabledSubtitleTracks();
        this.controller = new PrimingController({
            settings: this.context.getPrimingSettings(),
            subtitles: this.context.subtitles,
            media: this.createMediaAdapter(),
            onCueChanged: () => this.context.onPrimingStateChanged?.(),
            onPassChanged: () => this.context.onPrimingStateChanged?.(),
        });
        this.controller.start();
    }

    private markInternal(): void {
        this.ignoreExternalUntil = performance.now() + 800;
    }

    private get ignoringExternal(): boolean {
        return performance.now() < this.ignoreExternalUntil;
    }

    private ensureBlackoutElement(): HTMLDivElement {
        if (this.blackoutElement) return this.blackoutElement;

        const element = document.createElement('div');
        element.style.position = 'absolute';
        element.style.inset = '0';
        element.style.background = '#000';
        element.style.zIndex = '1';
        element.style.pointerEvents = 'none';
        element.style.display = 'none';

        const parent = this.context.video.parentElement;
        if (parent && getComputedStyle(parent).position === 'static') {
            parent.style.position = 'relative';
        }
        parent?.insertBefore(element, this.context.video.nextSibling);
        this.blackoutElement = element;
        return element;
    }

    private flashRewind(): void {
        if (!this.flashElement) {
            const element = document.createElement('div');
            element.style.position = 'absolute';
            element.style.inset = '0';
            element.style.background = '#fff';
            element.style.opacity = '0';
            element.style.zIndex = '2';
            element.style.pointerEvents = 'none';

            const parent = this.context.video.parentElement;
            if (parent && getComputedStyle(parent).position === 'static') {
                parent.style.position = 'relative';
            }
            parent?.insertBefore(element, this.context.video.nextSibling);
            this.flashElement = element;
        }

        this.flashElement.animate([{ opacity: 0 }, { opacity: 0.18, offset: 0.25 }, { opacity: 0 }], {
            duration: 220,
            easing: 'ease-out',
        });
    }

    private hideBlackout(): void {
        if (this.blackoutElement) {
            this.blackoutElement.style.display = 'none';
        }
    }

    private createMediaAdapter(): MediaAdapter {
        const video = this.context.video as HTMLVideoElement;

        return {
            currentTimeMs: () => this.context.currentTimeMs(),
            durationMs: () => (Number.isFinite(video.duration) ? video.duration * 1000 : 0),
            seek: async (timestampMs) => {
                this.markInternal();
                await this.context.seek(timestampMs);
                await this.waitForSeeked(video, timestampMs);
                this.markInternal();
            },
            play: async () => {
                this.markInternal();
                await this.context.play();
            },
            pause: () => {
                this.markInternal();
                this.context.pause();
            },
            setPlaybackRate: (rate) => {
                if (video.playbackRate !== rate) {
                    video.playbackRate = rate;
                }
            },
            setVisibleTracks: (indices) => this.context.setVisibleTracks(indices),
            setBlackout: (on) => {
                const element = this.ensureBlackoutElement();
                element.style.display = on ? 'block' : 'none';
            },
            flashRewind: () => this.flashRewind(),
            waitUntilTime: (targetMs) => this.waitUntilTime(video, targetMs),
            cancelPendingWait: () => this.cancelWait(),
            trackKinds: () => this.trackKinds(),
            onExternalSeek: (cb) => {
                const listener = () => {
                    if (this.ignoringExternal || this.recordingSuppressed) return;
                    cb(this.context.currentTimeMs());
                };
                video.addEventListener('seeked', listener);
                return () => video.removeEventListener('seeked', listener);
            },
            onExternalPause: (cb) => {
                const listener = () => {
                    if (this.ignoringExternal || this.recordingSuppressed) return;
                    cb();
                };
                video.addEventListener('pause', listener);
                return () => video.removeEventListener('pause', listener);
            },
            onExternalPlay: (cb) => {
                const listener = () => {
                    if (this.ignoringExternal || this.recordingSuppressed) return;
                    cb();
                };
                video.addEventListener('play', listener);
                return () => video.removeEventListener('play', listener);
            },
            onVisibilityHidden: (cb) => {
                const listener = () => {
                    if (document.hidden) cb();
                };
                document.addEventListener('visibilitychange', listener);
                return () => document.removeEventListener('visibilitychange', listener);
            },
            onVisibilityVisible: (cb) => {
                const listener = () => {
                    if (!document.hidden) cb();
                };
                document.addEventListener('visibilitychange', listener);
                return () => document.removeEventListener('visibilitychange', listener);
            },
        };
    }

    private trackKinds() {
        return buildPrimingTrackKinds(this.context.subtitles(), this.context.subtitleFileNames());
    }

    private waitForSeeked(video: HTMLVideoElement, targetMs: number): Promise<void> {
        const closeEnough = () => Math.abs(this.context.currentTimeMs() - targetMs) < 350;
        if (closeEnough()) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            let settled = false;
            const done = () => {
                if (settled) return;
                settled = true;
                video.removeEventListener('seeked', done);
                window.clearInterval(interval);
                window.clearTimeout(timeout);
                resolve();
            };
            video.addEventListener('seeked', done);
            const interval = window.setInterval(() => {
                if (closeEnough()) done();
            }, 16);
            const timeout = window.setTimeout(done, 400);
        });
    }

    private waitResolve?: (reached: boolean) => void;

    private waitUntilTime(video: HTMLVideoElement, targetMs: number): Promise<boolean> {
        const generation = ++this.waitGeneration;
        const currentMs = () => this.context.currentTimeMs();

        return new Promise((resolve) => {
            const cleanupFns: Array<() => void> = [];
            const finish = (reached: boolean) => {
                if (this.waitResolve !== finish) return;
                this.waitResolve = undefined;
                for (const cleanup of cleanupFns) cleanup();
                resolve(reached);
            };
            this.waitResolve = finish;

            const onTick = () => {
                if (generation !== this.waitGeneration) {
                    finish(false);
                    return;
                }
                if (currentMs() >= targetMs) {
                    this.waitGeneration += 1;
                    finish(true);
                }
            };

            if (currentMs() >= targetMs) {
                finish(true);
                return;
            }

            const interval = window.setInterval(onTick, 16);
            cleanupFns.push(() => window.clearInterval(interval));

            video.addEventListener('timeupdate', onTick);
            cleanupFns.push(() => video.removeEventListener('timeupdate', onTick));

            if ('requestVideoFrameCallback' in video) {
                let handle = 0;
                const tick = () => {
                    onTick();
                    if (generation === this.waitGeneration && currentMs() < targetMs) {
                        handle = video.requestVideoFrameCallback(tick);
                    }
                };
                handle = video.requestVideoFrameCallback(tick);
                cleanupFns.push(() => {
                    if ('cancelVideoFrameCallback' in video) {
                        video.cancelVideoFrameCallback(handle);
                    }
                });
            }
        });
    }

    private cancelWait(): void {
        this.waitGeneration += 1;
        this.waitResolve?.(false);
    }
}
