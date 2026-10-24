import { describe, expect, it } from '@jest/globals';
import {
    buildSubtitleStreamUrl,
    isTextSubtitleStream,
    looksLikeMediaSourceList,
    streamsFromMediaSources,
    subtitleFileExtension,
    subtitleTrackDefsFromStreams,
    withApiKey,
    type EmbyMediaStream,
} from './emby-jellyfin-util';

const assEmbedded: EmbyMediaStream = {
    Type: 'Subtitle',
    Codec: 'ass',
    DisplayTitle: 'Forced - French - Default - ASS',
    Language: 'fre',
    Index: 2,
    IsTextSubtitleStream: true,
    IsExternal: false,
};

const japaneseAss: EmbyMediaStream = {
    Type: 'Subtitle',
    Codec: 'ASS',
    DisplayTitle: 'Japanese - ASS',
    Language: 'jpn',
    Index: 5,
    IsExternal: false,
};

const pgs: EmbyMediaStream = {
    Type: 'Subtitle',
    Codec: 'pgssub',
    DisplayTitle: 'English PGS',
    Language: 'eng',
    Index: 3,
    IsTextSubtitleStream: false,
    IsExternal: false,
};

describe('isTextSubtitleStream', () => {
    it('includes embedded ASS tracks from an MKV', () => {
        expect(isTextSubtitleStream(assEmbedded)).toBe(true);
        expect(isTextSubtitleStream(japaneseAss)).toBe(true);
    });

    it('excludes image subtitle codecs', () => {
        expect(isTextSubtitleStream(pgs)).toBe(false);
    });

    it('treats codec as text when IsTextSubtitleStream is missing', () => {
        expect(isTextSubtitleStream({ Type: 'Subtitle', Codec: 'subrip', Index: 4 })).toBe(true);
    });

    it('accepts Jellyfin numeric MediaStreamType for subtitles', () => {
        expect(isTextSubtitleStream({ Type: 2, Codec: 'ass', Index: 2, IsExternal: false })).toBe(true);
        expect(isTextSubtitleStream({ Type: 1, Codec: 'h264', Index: 0 })).toBe(false);
    });
});

describe('subtitleFileExtension', () => {
    it('keeps ASS/SSA for embedded MKV tracks so drawings and karaoke tags are not flattened to SRT', () => {
        expect(subtitleFileExtension(assEmbedded)).toBe('ass');
        expect(subtitleFileExtension({ Codec: 'ssa', IsExternal: false })).toBe('ssa');
    });

    it('keeps ASS/SSA for external sidecar files', () => {
        expect(subtitleFileExtension({ Codec: 'ass', IsExternal: true })).toBe('ass');
        expect(subtitleFileExtension({ Codec: 'ssa', IsExternal: true })).toBe('ssa');
    });

    it('asks Jellyfin to convert other text formats to srt', () => {
        expect(subtitleFileExtension({ Codec: 'mov_text' })).toBe('srt');
        expect(subtitleFileExtension({ Codec: 'subrip' })).toBe('srt');
    });
});

describe('subtitle URLs', () => {
    it('adds an api_key so the later fetch is authenticated', () => {
        expect(
            buildSubtitleStreamUrl({
                serverAddress: 'http://192.168.1.10:8096',
                origin: 'https://watch.example',
                itemId: 'item',
                mediaSourceId: 'source',
                index: 2,
                extension: 'ass',
                accessToken: 'token',
            })
        ).toBe('http://192.168.1.10:8096/Videos/item/source/Subtitles/2/Stream.ass?api_key=token');
    });

    it('falls back to the page origin when serverAddress is blank', () => {
        expect(
            buildSubtitleStreamUrl({
                serverAddress: '',
                origin: 'https://jellyfin.example',
                itemId: 'item',
                mediaSourceId: 'source',
                index: 1,
                extension: 'srt',
            })
        ).toBe('https://jellyfin.example/Videos/item/source/Subtitles/1/Stream.srt');
    });

    it('does not duplicate api_key', () => {
        expect(withApiKey('https://jf/sub.srt?api_key=x', 'y')).toBe('https://jf/sub.srt?api_key=x');
    });
});

describe('streamsFromMediaSources', () => {
    it('uses the playing MediaSource, which holds embedded MKV tracks', () => {
        const streams = streamsFromMediaSources(
            [
                { Id: 'other', MediaStreams: [{ Type: 'Subtitle', Codec: 'srt', Index: 1 }] },
                { Id: 'playing', MediaStreams: [assEmbedded, japaneseAss, pgs] },
            ],
            'playing'
        );
        expect(streams).toEqual([assEmbedded, japaneseAss, pgs]);
    });
});

describe('subtitleTrackDefsFromStreams', () => {
    it('builds asbplayer tracks for embedded MKV ASS streams and skips PGS', () => {
        const { tracks, imageSubtitleCount } = subtitleTrackDefsFromStreams(
            [{ Type: 'Video', Index: 0 }, { Type: 'Audio', Index: 1 }, assEmbedded, japaneseAss, pgs],
            {
                serverAddress: 'https://jellyfin.local',
                origin: 'https://jellyfin.local',
                itemId: 'movie',
                mediaSourceId: 'mkv',
                accessToken: 'secret',
            }
        );

        expect(imageSubtitleCount).toBe(1);
        expect(tracks).toEqual([
            {
                label: 'Forced - French - Default - ASS (embedded)',
                language: 'fre',
                url: 'https://jellyfin.local/Videos/movie/mkv/Subtitles/2/Stream.ass?api_key=secret',
                extension: 'ass',
            },
            {
                label: 'Japanese - ASS (embedded)',
                language: 'jpn',
                url: 'https://jellyfin.local/Videos/movie/mkv/Subtitles/5/Stream.ass?api_key=secret',
                extension: 'ass',
            },
        ]);
    });
});

describe('looksLikeMediaSourceList', () => {
    it('recognizes PlaybackInfo and item payloads', () => {
        expect(looksLikeMediaSourceList({ MediaSources: [{ Id: 'a', MediaStreams: [assEmbedded] }] })).toBe(true);
        expect(looksLikeMediaSourceList({ Name: 'Movie' })).toBe(false);
    });
});
