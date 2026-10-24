import { describe, expect, it, jest } from '@jest/globals';
jest.mock('@qgustavor/srt-parser', () => ({ __esModule: true, default: class {} }));
jest.mock('videojs-vtt.js', () => ({ WebVTT: {} }));

import { compile } from 'ass-compiler';
import {
    assDialogueText,
    isLetterLikeCue,
    mergeOverlappingLetterCues,
    stripAssTypesetting,
} from '@project/common/subtitle-reader/ass-text';
import SubtitleReader from '@project/common/subtitle-reader/subtitle-reader';
import { SubtitleHtml } from '@project/common';

const assDocument = (dialogue: string) => `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${dialogue}`;

describe('stripAssTypesetting', () => {
    it('drops leftover override tags and drawing paths from ffmpeg SRT conversion', () => {
        expect(
            stripAssTypesetting(
                '{\\an8}hello{\\b1}\nm 50 0 b 22 0 0 22 0 50 b 0 78 22 100 50 100 b 78 100 100 78 100 50 b 100 22 78 0 50 0'
            )
        ).toBe('hello');
    });

    it('treats a drawing-only cue as empty', () => {
        expect(
            stripAssTypesetting(
                'm 50 0 b 22 0 0 22 0 50 b 0 78 22 100 50 100 b 78 100 100 78 100 50 b 100 22 78 0 50 0'
            )
        ).toBe('');
    });
});

describe('assDialogueText', () => {
    it('keeps spoken text, skips drawings, and wraps inline bold/italic', () => {
        const compiled = compile(
            assDocument(
                'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\b1}魔法{\\b0}\\N{\\i1}magic{\\i0}\\N{\\p1}m 50 0 b 22 0 0 22 0 50 b 0 78 22 100 50 100 b 78 100 100 78 100 50 b 100 22 78 0 50 0{\\p0}'
            ),
            {}
        );

        expect(assDialogueText(compiled.dialogues[0], true)).toBe('<b>魔法</b>\n<i>magic</i>');
        expect(assDialogueText(compiled.dialogues[0], false)).toBe('魔法\nmagic');
    });

    it('drops drawing-only events', () => {
        const compiled = compile(
            assDocument('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\p1}m 50 0 b 22 0 0 22 0 50{\\p0}'),
            {}
        );

        expect(assDialogueText(compiled.dialogues[0], true)).toBe('');
    });
});

describe('mergeOverlappingLetterCues', () => {
    it('rebuilds karaoke letters split across overlapping events', () => {
        expect(isLetterLikeCue('m')).toBe(true);
        expect(isLetterLikeCue('<b>あ</b>')).toBe(true);
        expect(isLetterLikeCue('hello')).toBe(false);

        expect(
            mergeOverlappingLetterCues([
                { start: 1000, end: 3000, text: 'm', track: 0 },
                { start: 1200, end: 3000, text: 'a', track: 0 },
                { start: 1400, end: 3000, text: 'h', track: 0 },
                { start: 1600, end: 3000, text: 'o', track: 0 },
                { start: 1800, end: 3000, text: 'u', track: 0 },
                { start: 2000, end: 3000, text: 's', track: 0 },
                { start: 1100, end: 2000, text: 'EN', track: 1 },
                { start: 5000, end: 6000, text: 'こんにちは', track: 0 },
            ])
        ).toEqual([
            { start: 1000, end: 3000, text: 'mahous', track: 0 },
            { start: 1100, end: 2000, text: 'EN', track: 1 },
            { start: 5000, end: 6000, text: 'こんにちは', track: 0 },
        ]);
    });
});

describe('SubtitleReader ASS/SSA', () => {
    const file = (name: string, text: string) => ({ name, text: async () => text }) as unknown as File;
    const reader = () =>
        new SubtitleReader({
            regexFilter: '',
            regexFilterTextReplacement: '',
            subtitleHtml: SubtitleHtml.render,
            convertNetflixRuby: false,
            pgsParserWorkerFactory: () => Promise.reject(new Error('PGS worker is not used in these tests')),
        });

    it('parses SSA, drops drawings, and merges karaoke letters', async () => {
        const subtitles = await reader().subtitles([
            file(
                'op.ssa',
                assDocument(
                    [
                        'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(100,200)}m',
                        'Dialogue: 0,0:00:01.20,0:00:03.00,Default,,0,0,0,,{\\pos(120,200)}a',
                        'Dialogue: 0,0:00:01.20,0:00:03.00,Default,,0,0,0,,{\\p1}m 50 0 b 22 0 0 22 0 50 b 0 78 22 100 50 100 b 78 100 100 78 100 50 b 100 22 78 0 50 0{\\p0}',
                        'Dialogue: 0,0:00:01.40,0:00:03.00,Default,,0,0,0,,{\\pos(140,200)}h',
                        'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\b1}こんにちは{\\b0}',
                    ].join('\n')
                )
            ),
        ]);

        expect(subtitles).toEqual([
            expect.objectContaining({ start: 1000, end: 3000, text: 'mah' }),
            expect.objectContaining({ start: 5000, end: 6000, text: '<b>こんにちは</b>' }),
        ]);
    });
});
