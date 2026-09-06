export type SubtitleTrackVisibilityMode = 'all' | 'single0' | 'single1' | 'none';

export function detectSubtitleTrackVisibilityMode(
    loadedTracks: readonly number[],
    displaySubtitles: boolean,
    disabledSubtitleTracks: { readonly [key: number]: boolean | undefined }
): SubtitleTrackVisibilityMode {
    if (loadedTracks.length < 2) {
        return displaySubtitles ? 'all' : 'none';
    }

    if (!displaySubtitles) {
        return 'none';
    }

    const enabledTracks = loadedTracks.filter((track) => !disabledSubtitleTracks[track]);
    if (enabledTracks.length === loadedTracks.length) {
        return 'all';
    }
    if (enabledTracks.length === 0) {
        return 'none';
    }
    if (enabledTracks.length === 1) {
        if (enabledTracks[0] === loadedTracks[0]) {
            return 'single0';
        }
        if (enabledTracks[0] === loadedTracks[1]) {
            return 'single1';
        }
    }

    return 'all';
}

export function nextSubtitleTrackVisibilityMode(
    current: SubtitleTrackVisibilityMode
): SubtitleTrackVisibilityMode {
    switch (current) {
        case 'all':
            return 'single0';
        case 'single0':
            return 'single1';
        case 'single1':
            return 'none';
        case 'none':
            return 'all';
    }
}

export function applySubtitleTrackVisibilityMode(
    mode: SubtitleTrackVisibilityMode,
    loadedTracks: readonly number[],
    disabledSubtitleTracks: { [key: number]: boolean | undefined }
): boolean {
    for (const track of loadedTracks) {
        delete disabledSubtitleTracks[track];
    }

    switch (mode) {
        case 'all':
            return true;
        case 'single0':
            disabledSubtitleTracks[loadedTracks[1]] = true;
            return true;
        case 'single1':
            disabledSubtitleTracks[loadedTracks[0]] = true;
            return true;
        case 'none':
            return false;
    }
}

export function loadedSubtitleTrackIndexes(subtitles: readonly { track: number }[]): number[] {
    const tracks = new Set<number>();
    for (const subtitle of subtitles) {
        tracks.add(subtitle.track);
    }
    return [...tracks].sort((left, right) => left - right);
}

/** When only one subtitle track is visible, return its index for mining. */
export function preferredMiningTrackFromVisibility(
    loadedTracks: readonly number[],
    displaySubtitles: boolean,
    disabledSubtitleTracks: { readonly [key: number]: boolean | undefined }
): number | undefined {
    const mode = detectSubtitleTrackVisibilityMode(loadedTracks, displaySubtitles, disabledSubtitleTracks);
    switch (mode) {
        case 'single0':
            return loadedTracks[0];
        case 'single1':
            return loadedTracks[1];
        default:
            return undefined;
    }
}
