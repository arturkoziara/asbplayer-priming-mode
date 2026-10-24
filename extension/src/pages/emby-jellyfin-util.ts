import type { VideoDataSubtitleTrackDef } from '@project/common';

const TEXT_SUBTITLE_CODECS = new Set([
    'ass',
    'ssa',
    'srt',
    'subrip',
    'vtt',
    'webvtt',
    'mov_text',
    'ttml',
    'text',
    'sub',
    'sami',
    'sami_utf8',
    'microdvd',
]);

const IMAGE_SUBTITLE_CODECS = new Set([
    'pgssub',
    'pgs',
    'hdmv_pgs_subtitle',
    'dvdsub',
    'dvd_subtitle',
    'vobsub',
    'dvb_subtitle',
    'dvbsub',
    'xsub',
]);

export interface EmbyMediaStream {
    Type?: string | number;
    IsTextSubtitleStream?: boolean;
    IsExternal?: boolean;
    Codec?: string;
    DisplayTitle?: string;
    Title?: string;
    Language?: string;
    Index?: number;
    Path?: string;
    DeliveryUrl?: string;
    SupportsExternalStream?: boolean;
}

export interface EmbyMediaSource {
    Id?: string;
    MediaStreams?: EmbyMediaStream[];
}

function codecOf(stream: EmbyMediaStream): string {
    return (stream.Codec ?? '').trim().toLowerCase();
}

export function isSubtitleStreamType(stream: EmbyMediaStream): boolean {
    return stream.Type === 'Subtitle' || stream.Type === 2;
}

export function isImageSubtitleStream(stream: EmbyMediaStream): boolean {
    if (stream.Type !== undefined && !isSubtitleStreamType(stream)) {
        return false;
    }

    if (stream.IsTextSubtitleStream === false) {
        return true;
    }

    return IMAGE_SUBTITLE_CODECS.has(codecOf(stream));
}

export function isTextSubtitleStream(stream: EmbyMediaStream): boolean {
    if (stream.Type !== undefined && !isSubtitleStreamType(stream)) {
        return false;
    }

    if (stream.IsTextSubtitleStream === true) {
        return true;
    }

    if (stream.IsTextSubtitleStream === false) {
        return false;
    }

    const codec = codecOf(stream);
    if (IMAGE_SUBTITLE_CODECS.has(codec)) {
        return false;
    }

    if (TEXT_SUBTITLE_CODECS.has(codec)) {
        return true;
    }

    return isSubtitleStreamType(stream);
}

export function subtitleFileExtension(stream: EmbyMediaStream): string {
    // Ask for native ASS/SSA. ffmpeg's ASS→SRT conversion strips `\p` drawing
    // tags but leaves the path (`m 50 0 b 22 0…`) and karaoke letters as fake
    // dialogue. Native rendering is already disabled, and blob URL rotation no
    // longer re-extracts, so this is a one-time demux rather than a live transcode.
    const codec = codecOf(stream);
    if (codec === 'ass' || codec === 'ssa') {
        return codec;
    }
    if (codec === 'vtt' || codec === 'webvtt') {
        return 'vtt';
    }
    // Jellyfin/Emby convert other text formats (mov_text, subrip, …) to SRT.
    return 'srt';
}

export function resolveServerAddress(serverAddress: string | undefined, origin: string): string {
    const address = (serverAddress ?? '').trim().replace(/\/+$/, '');
    if (/^https?:\/\//i.test(address)) {
        return address;
    }
    if (address.startsWith('/')) {
        return `${origin.replace(/\/+$/, '')}${address}`;
    }
    return origin.replace(/\/+$/, '');
}

export function withApiKey(url: string, accessToken: string | undefined): string {
    if (!accessToken || /(?:\?|&)api_key=/.test(url)) {
        return url;
    }
    return `${url}${url.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(accessToken)}`;
}

export function buildSubtitleStreamUrl(options: {
    serverAddress: string;
    origin: string;
    itemId: string;
    mediaSourceId: string;
    index: number;
    extension: string;
    accessToken?: string;
}): string {
    const server = resolveServerAddress(options.serverAddress, options.origin);
    const url = `${server}/Videos/${options.itemId}/${options.mediaSourceId}/Subtitles/${options.index}/Stream.${options.extension}`;
    return withApiKey(url, options.accessToken);
}

export function streamsFromMediaSources(
    sources: EmbyMediaSource[] | undefined,
    mediaSourceId: string | undefined
): EmbyMediaStream[] {
    if (!Array.isArray(sources) || sources.length === 0) {
        return [];
    }

    const match = (mediaSourceId ? sources.find((source) => source?.Id === mediaSourceId) : undefined) ?? sources[0];
    return Array.isArray(match?.MediaStreams) ? match.MediaStreams : [];
}

export function looksLikeMediaSourceList(value: unknown): value is { MediaSources: EmbyMediaSource[] } {
    if (value === null || typeof value !== 'object') {
        return false;
    }

    const mediaSources = (value as { MediaSources?: unknown }).MediaSources;
    return (
        Array.isArray(mediaSources) &&
        mediaSources.some((source) => Array.isArray((source as EmbyMediaSource | undefined)?.MediaStreams))
    );
}

function streamLabel(stream: EmbyMediaStream): string {
    const base =
        stream.DisplayTitle ||
        [stream.Title, stream.Language, stream.Codec].filter((part) => part && String(part).trim()).join(' - ') ||
        'Subtitle';

    if (stream.IsExternal === false && !/\(embedded\)/i.test(base)) {
        return `${base} (embedded)`;
    }
    if (stream.IsExternal === true && !/\(file\)/i.test(base)) {
        return `${base} (file)`;
    }
    return base;
}

export function subtitleTrackDefsFromStreams(
    streams: EmbyMediaStream[] | undefined,
    options: {
        serverAddress: string;
        origin: string;
        itemId: string;
        mediaSourceId: string;
        accessToken?: string;
    }
): { tracks: VideoDataSubtitleTrackDef[]; imageSubtitleCount: number } {
    const tracks: VideoDataSubtitleTrackDef[] = [];
    let imageSubtitleCount = 0;

    for (const stream of streams ?? []) {
        if (stream.Type !== undefined && !isSubtitleStreamType(stream)) {
            continue;
        }

        if (typeof stream.Index !== 'number') {
            continue;
        }

        if (isImageSubtitleStream(stream) && !isTextSubtitleStream(stream)) {
            imageSubtitleCount += 1;
            continue;
        }

        if (!isTextSubtitleStream(stream)) {
            continue;
        }

        const extension = subtitleFileExtension(stream);
        tracks.push({
            label: streamLabel(stream),
            language: stream.Language || '',
            url: buildSubtitleStreamUrl({
                ...options,
                index: stream.Index,
                extension,
            }),
            extension,
        });
    }

    return { tracks, imageSubtitleCount };
}
