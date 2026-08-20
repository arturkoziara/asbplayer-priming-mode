import type { PrimingPassKind } from '@project/common/settings/settings';

export type { PrimingPassKind };
export type PrimingTrackKind = 'en' | 'jp' | 'unknown';

export interface PrimingSequencePreset {
    readonly id: string;
    readonly sequence: readonly PrimingPassKind[];
}

export const primingSequencePresets: readonly PrimingSequencePreset[] = [
    { id: 'en-raw-jp', sequence: ['en', 'raw', 'jp'] },
    { id: 'en-jp', sequence: ['en', 'jp'] },
    { id: 'en-raw', sequence: ['en', 'raw'] },
    { id: 'raw-en-jp', sequence: ['raw', 'en', 'jp'] },
    { id: 'en-en-jp', sequence: ['en', 'en', 'jp'] },
];

const jpNameToken = /^(ja|jp|jpn|japanese|nihongo)$/;
const enNameToken = /^(en|eng|english)$/;
const languageNameToken = /(?:^|[^a-z])(ja|jp|jpn|japanese|nihongo|en|eng|english)(?=[^a-z]|$)/g;

export function formatPrimingSequence(sequence: readonly PrimingPassKind[]): string {
    return sequence.map((kind) => kind.toUpperCase()).join(' → ');
}

export function sequencesEqual(
    left: readonly PrimingPassKind[] | undefined,
    right: readonly PrimingPassKind[] | undefined
): boolean {
    if (left === right) return true;
    if (!left || !right || left.length !== right.length) return false;
    return left.every((kind, index) => kind === right[index]);
}

export function nextPrimingSequence(sequence: readonly PrimingPassKind[]): PrimingPassKind[] {
    const current = formatPrimingSequence(sequence);
    const index = primingSequencePresets.findIndex((preset) => formatPrimingSequence(preset.sequence) === current);
    const next = primingSequencePresets[(index + 1) % primingSequencePresets.length] ?? primingSequencePresets[0];
    return [...next.sequence];
}

export function classifySubtitleTrack(fileName: string | undefined, sampleText: string): PrimingTrackKind {
    const name = (fileName ?? '').toLowerCase();
    const tokens = [...name.matchAll(languageNameToken)].map((match) => match[1]);
    const last = tokens[tokens.length - 1];
    if (last && jpNameToken.test(last)) return 'jp';
    if (last && enNameToken.test(last)) return 'en';

    const cjk = (sampleText.match(/[\u3040-\u30ff\u3400-\u9fff]/g) ?? []).length;
    const latin = (sampleText.match(/[A-Za-z]/g) ?? []).length;
    if (cjk >= 8 && cjk >= latin) return 'jp';
    if (latin >= 12 && latin > cjk * 2) return 'en';
    return 'unknown';
}

export function visibleTracksForPass(
    kind: PrimingPassKind,
    tracks: ReadonlyMap<number, PrimingTrackKind>
): readonly number[] {
    if (kind === 'raw') return [];

    const wanted: PrimingTrackKind = kind;
    const matching: number[] = [];
    const otherLanguage: number[] = [];
    const unknown: number[] = [];

    for (const [index, trackKind] of tracks) {
        if (trackKind === wanted) matching.push(index);
        else if (trackKind === 'unknown') unknown.push(index);
        else otherLanguage.push(index);
    }

    if (matching.length > 0) return matching;
    if (unknown.length === 1 && otherLanguage.length > 0) return unknown;

    if (unknown.length > 1 && otherLanguage.length === 0) {
        const sorted = [...unknown].sort((a, b) => a - b);
        return kind === 'jp' ? [sorted[sorted.length - 1]] : [sorted[0]];
    }

    if (unknown.length > 0 && otherLanguage.length === 0) return [unknown[0]];
    return [];
}

export function preferredDrillTrack(tracks: ReadonlyMap<number, PrimingTrackKind>): number | undefined {
    for (const [index, kind] of tracks) {
        if (kind === 'jp') return index;
    }
    for (const [index, kind] of tracks) {
        if (kind === 'en') return index;
    }
    const first = tracks.keys().next();
    return first.done ? undefined : first.value;
}
