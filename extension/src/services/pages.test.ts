import { defaultSettings } from '@project/common/settings';
import pagesConfig from '@project/extension/src/pages.json';
import { afterEach, beforeAll, expect, it } from '@jest/globals';
import type { PageDelegate as PageDelegateClass } from '@project/extension/src/services/pages';

let PageDelegate: typeof PageDelegateClass;
let pageConfigMatchesUrl: (typeof import('@project/extension/src/services/pages'))['pageConfigMatchesUrl'];

beforeAll(async () => {
    const storage = {
        clear: async () => undefined,
        get: async () => ({}),
        remove: async () => undefined,
        set: async () => undefined,
    };
    Object.defineProperty(globalThis, 'browser', {
        configurable: true,
        value: { runtime: { getURL: (path: string) => path }, storage: { local: storage } },
    });
    Object.defineProperty(globalThis, 'chrome', {
        configurable: true,
        value: { runtime: { getURL: (path: string) => path } },
    });
    const pages = await import('@project/extension/src/services/pages');
    PageDelegate = pages.PageDelegate;
    pageConfigMatchesUrl = pages.pageConfigMatchesUrl;
});

afterEach(() => {
    document.body.replaceChildren();
});

it('page settings and page configs are consistent', () => {
    for (const page of pagesConfig.pages) {
        expect(page.key in defaultSettings.streamingPages).toBe(true);
    }

    for (const key of Object.keys(defaultSettings.streamingPages)) {
        expect(pagesConfig.pages.find((p) => p.key === key) !== undefined).toBe(true);
    }
});

it('keeps nonmatching videos bindable but prevents them from auto-syncing', () => {
    const page = new PageDelegate(
        {
            host: 'www\\.youtube\\.com',
            preferredVideoElementSelector: '#movie_player video',
            autoSync: { enabled: true },
        },
        new URL('https://www.youtube.com/watch?v=video')
    );
    const player = document.createElement('div');
    player.id = 'movie_player';
    const playerVideo = document.createElement('video');
    const thumbnailVideo = document.createElement('video');
    player.append(playerVideo);
    document.body.append(player, thumbnailVideo);

    expect(page.shouldIgnore(playerVideo)).toBe(false);
    expect(page.shouldIgnore(thumbnailVideo)).toBe(false);
    expect(page.canAutoSync(playerVideo)).toBe(true);
    expect(page.canAutoSync(thumbnailVideo)).toBe(false);
    expect(page.ownsSubtitleSync(playerVideo)).toBe(true);
    expect(page.ownsSubtitleSync(thumbnailVideo)).toBe(false);
});

it('gives subtitle picker ownership to one video when YouTube has a player and ad video', () => {
    const page = new PageDelegate(
        {
            host: 'www\\.youtube\\.com',
            preferredVideoElementSelector: '#movie_player video',
            autoSync: { enabled: true },
        },
        new URL('https://www.youtube.com/watch?v=video')
    );
    const player = document.createElement('div');
    player.id = 'movie_player';
    const mainVideo = document.createElement('video');
    mainVideo.className = 'html5-main-video';
    const adVideo = document.createElement('video');
    player.append(adVideo, mainVideo);
    document.body.append(player);

    expect(page.canAutoSync(mainVideo)).toBe(true);
    expect(page.canAutoSync(adVideo)).toBe(true);
    expect(page.ownsSubtitleSync(mainVideo)).toBe(true);
    expect(page.ownsSubtitleSync(adVideo)).toBe(false);
});

it('sorts preferred videos before nonmatching videos for manual selection', () => {
    const page = new PageDelegate(
        {
            host: 'www\\.youtube\\.com',
            preferredVideoElementSelector: '#movie_player video',
            autoSync: { enabled: true },
        },
        new URL('https://www.youtube.com/watch?v=video')
    );
    const player = document.createElement('div');
    player.id = 'movie_player';
    const playerVideo = document.createElement('video');
    const firstThumbnailVideo = document.createElement('video');
    const secondThumbnailVideo = document.createElement('video');
    player.append(playerVideo);
    document.body.append(firstThumbnailVideo, player, secondThumbnailVideo);

    const sorted = [firstThumbnailVideo, playerVideo, secondThumbnailVideo].sort(
        (a, b) => page.videoElementPreference(a) - page.videoElementPreference(b)
    );

    expect(sorted).toEqual([playerVideo, firstThumbnailVideo, secondThumbnailVideo]);
});

it('detects Jellyfin web on a LAN IP and custom port via /web', () => {
    const jellyfin = pagesConfig.pages.find((page) => page.key === 'embyJellyfin');
    expect(jellyfin).toBeDefined();
    const page = jellyfin!;

    expect(pageConfigMatchesUrl(page, new URL('http://192.168.20.201:30013/web/#/video'))).toBe(true);
    expect(pageConfigMatchesUrl(page, new URL('http://192.168.20.201:30013/web/index.html#/video'))).toBe(true);
    expect(pageConfigMatchesUrl(page, new URL('http://192.168.20.201:30013/web/#/home'))).toBe(true);
    expect(pageConfigMatchesUrl(page, new URL('https://media.example.com/jellyfin/web/#/video'))).toBe(true);
    expect(pageConfigMatchesUrl(page, new URL('http://192.168.20.201:30013/dashboard'))).toBe(false);

    const videoPage = new PageDelegate(page, new URL('http://192.168.20.201:30013/web/#/video'));
    expect(videoPage.isVideoPage()).toBe(true);
    expect(new PageDelegate(page, new URL('http://192.168.20.201:30013/web/#/home')).isVideoPage()).toBe(false);
});

it('preserves auto-sync eligibility and ordering when no selector is configured', () => {
    const page = new PageDelegate(
        {
            host: 'example\\.com',
            autoSync: { enabled: true },
        },
        new URL('https://example.com/video')
    );
    const firstVideo = document.createElement('video');
    const secondVideo = document.createElement('video');

    expect(page.shouldIgnore(firstVideo)).toBe(false);
    expect(page.canAutoSync(firstVideo)).toBe(true);
    expect(page.canAutoSync(secondVideo)).toBe(true);
    expect(page.videoElementPreference(firstVideo)).toBe(0);
    expect(page.videoElementPreference(secondVideo)).toBe(0);
});
