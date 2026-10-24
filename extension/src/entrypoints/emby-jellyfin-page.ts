import type { VideoData } from '@project/common';
import { trackFromDef } from '@/pages/util';
import { asbError } from '@project/common/util';
import {
    looksLikeMediaSourceList,
    streamsFromMediaSources,
    subtitleTrackDefsFromStreams,
    withApiKey,
    type EmbyMediaSource,
    type EmbyMediaStream,
} from '@/pages/emby-jellyfin-util';

declare const ApiClient: any | undefined;

type EmbySession = {
    Id?: string;
    DeviceId?: string;
    PlayState?: { MediaSourceId?: string };
    NowPlayingItem?: {
        Id?: string;
        Name?: string;
        Path?: string;
        FileName?: string;
        MediaStreams?: EmbyMediaStream[];
        MediaSources?: EmbyMediaSource[];
    };
};

function getApiClient(): any | undefined {
    const fromWindow = (window as unknown as { ApiClient?: unknown }).ApiClient;
    if (fromWindow) {
        return fromWindow;
    }
    return typeof ApiClient === 'undefined' ? undefined : ApiClient;
}

function itemIdFromPlaybackInfoUrl(url: string): string | undefined {
    return url.match(/\/Items\/([^/?#]+)\/PlaybackInfo/i)?.[1];
}

function captureMediaSources(value: unknown, sink: { current: EmbyMediaSource[] }) {
    if (looksLikeMediaSourceList(value)) {
        sink.current = value.MediaSources;
    }
}

function disableHtmlTextTracks() {
    for (const video of document.querySelectorAll('video')) {
        for (const textTrack of video.textTracks) {
            textTrack.mode = 'disabled';
        }
    }
}

function disableNativeSubtitles(apiClient: any, session: EmbySession | undefined) {
    disableHtmlTextTracks();

    try {
        const playbackManager = (window as unknown as { playbackManager?: any }).playbackManager;
        if (typeof playbackManager?.setSubtitleStreamIndex === 'function') {
            try {
                playbackManager.setSubtitleStreamIndex(-1);
            } catch {
                playbackManager.setSubtitleStreamIndex(playbackManager.getCurrentPlayer?.() ?? undefined, -1);
            }
        }
    } catch {
        // Native player APIs differ across Jellyfin/Emby builds.
    }

    const sessionId = session?.Id;
    if (!sessionId) {
        return;
    }

    try {
        const url =
            typeof apiClient.getUrl === 'function'
                ? apiClient.getUrl(`Sessions/${sessionId}/Playing/Subtitle`, { SubtitleStreamIndex: -1 })
                : `${window.location.origin}/Sessions/${sessionId}/Playing/Subtitle?SubtitleStreamIndex=-1`;
        const token = typeof apiClient.accessToken === 'function' ? apiClient.accessToken() : undefined;
        void fetch(withApiKey(url, typeof token === 'string' ? token : undefined), { method: 'POST' }).catch(
            () => undefined
        );
    } catch {
        // Best-effort: asbplayer can still load tracks if Jellyfin keeps its own overlay.
    }
}

function installPlaybackInfoCapture(sink: { current: EmbyMediaSource[] }) {
    let lastPlaybackItemId: string | undefined;
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        try {
            const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : '';
            const itemId = typeof url === 'string' ? itemIdFromPlaybackInfoUrl(url) : undefined;
            if (itemId && response.ok) {
                const contentType = response.headers.get('content-type') ?? '';
                if (contentType.includes('json') || contentType === '') {
                    const clone = response.clone();
                    void clone
                        .json()
                        .then((value) => {
                            captureMediaSources(value, sink);
                            if (lastPlaybackItemId !== undefined && lastPlaybackItemId !== itemId) {
                                document.dispatchEvent(new CustomEvent('asbplayer-video-changed'));
                            }
                            lastPlaybackItemId = itemId;
                        })
                        .catch(() => undefined);
                }
            }
        } catch {
            // Ignore capture failures; the request handler has other fallbacks.
        }
        return response;
    };
}

async function waitForSession(apiClient: any): Promise<EmbySession | undefined> {
    const deviceId = typeof apiClient.deviceId === 'function' ? apiClient.deviceId() : undefined;

    for (let attempt = 0; attempt < 5; attempt++) {
        const rawSessions = await apiClient.getSessions(deviceId ? { deviceId } : undefined);
        const sessions: EmbySession[] = Array.isArray(rawSessions) ? rawSessions : [];
        const session =
            sessions.find((candidate) => candidate?.PlayState?.MediaSourceId && candidate.NowPlayingItem?.Id) ??
            sessions.find((candidate) => candidate?.PlayState?.MediaSourceId) ??
            sessions[0];

        if (session?.PlayState?.MediaSourceId) {
            return session;
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return undefined;
}

async function mediaStreamsForPlayback(
    apiClient: any,
    itemId: string,
    mediaSourceId: string,
    nowPlayingItem: EmbySession['NowPlayingItem'],
    cachedMediaSources: EmbyMediaSource[]
): Promise<EmbyMediaStream[]> {
    const fromCache = streamsFromMediaSources(cachedMediaSources, mediaSourceId);
    if (fromCache.length > 0) {
        return fromCache;
    }

    try {
        const userId = typeof apiClient.getCurrentUserId === 'function' ? apiClient.getCurrentUserId() : undefined;
        if (userId && typeof apiClient.getItem === 'function') {
            const item = await apiClient.getItem(userId, itemId);
            const fromItem = streamsFromMediaSources(item?.MediaSources, mediaSourceId);
            if (fromItem.length > 0) {
                return fromItem;
            }
            if (Array.isArray(item?.MediaStreams) && item.MediaStreams.length > 0) {
                return item.MediaStreams;
            }
        }
    } catch (e) {
        asbError('emby-jellyfin', e);
    }

    const fromNowPlayingSources = streamsFromMediaSources(nowPlayingItem?.MediaSources, mediaSourceId);
    if (fromNowPlayingSources.length > 0) {
        return fromNowPlayingSources;
    }

    return Array.isArray(nowPlayingItem?.MediaStreams) ? nowPlayingItem.MediaStreams : [];
}

export default defineUnlistedScript(() => {
    const cachedMediaSources: { current: EmbyMediaSource[] } = { current: [] };
    installPlaybackInfoCapture(cachedMediaSources);

    document.addEventListener(
        'asbplayer-get-synced-data',
        () => {
            void (async () => {
                const response: VideoData = { error: '', basename: '', subtitles: [] };
                const apiClient = getApiClient();
                if (!apiClient) {
                    response.error = 'ApiClient is undefined';
                    return document.dispatchEvent(
                        new CustomEvent('asbplayer-synced-data', {
                            detail: response,
                        })
                    );
                }

                const session = await waitForSession(apiClient);
                const mediaSourceId = session?.PlayState?.MediaSourceId;
                const nowPlayingItem = session?.NowPlayingItem;

                if (!session || !mediaSourceId || !nowPlayingItem?.Id) {
                    response.error = 'Failed to retrieve a valid MediaSourceId after 5 attempts';
                    return document.dispatchEvent(
                        new CustomEvent('asbplayer-synced-data', {
                            detail: response,
                        })
                    );
                }

                const path = nowPlayingItem.Path;
                response.basename =
                    nowPlayingItem.FileName ?? (path ? path.split(/[\\/]/).pop() : nowPlayingItem.Name) ?? '';

                const streams = await mediaStreamsForPlayback(
                    apiClient,
                    nowPlayingItem.Id,
                    mediaSourceId,
                    nowPlayingItem,
                    cachedMediaSources.current
                );
                const accessToken = typeof apiClient.accessToken === 'function' ? apiClient.accessToken() : undefined;
                const serverAddress =
                    typeof apiClient.serverAddress === 'function' ? apiClient.serverAddress() : undefined;
                const { tracks, imageSubtitleCount } = subtitleTrackDefsFromStreams(streams, {
                    serverAddress: typeof serverAddress === 'string' ? serverAddress : '',
                    origin: window.location.origin,
                    itemId: nowPlayingItem.Id,
                    mediaSourceId,
                    accessToken: typeof accessToken === 'string' ? accessToken : undefined,
                });

                if (tracks.length > 0) {
                    disableNativeSubtitles(apiClient, session);
                }

                response.subtitles = tracks.map(trackFromDef);
                if (tracks.length === 0 && imageSubtitleCount > 0) {
                    response.error =
                        'This MKV only has image subtitles (PGS/VobSub). asbplayer needs text tracks such as ASS or SRT.';
                }

                document.dispatchEvent(
                    new CustomEvent('asbplayer-synced-data', {
                        detail: response,
                    })
                );
            })().catch((e) => {
                asbError('emby-jellyfin', e);
                const error = e instanceof Error ? e.message : String(e);
                document.dispatchEvent(
                    new CustomEvent('asbplayer-synced-data', {
                        detail: { error },
                    })
                );
            });
        },
        false
    );
});
