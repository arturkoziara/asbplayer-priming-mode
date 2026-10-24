import type { Dialogue, DialogueFragment } from 'ass-compiler';

const ASS_OVERRIDE_TAG = /\{[^{}]*\\[^{}]*\}/g;
// ASS vector drawings (`\p1`) look like "m 50 0 b 22 0 0 22 …". ffmpeg's ASS→SRT
// conversion strips the `\p` tag and leaves this path as if it were dialogue.
const ASS_DRAWING_COMMAND = /\b[mnlbs](?:\s+-?\d+(?:\.\d+)?){2}(?:\s+(?:[mnlbspc]|-?\d+(?:\.\d+)?))*/gi;

export interface AssCue {
    start: number;
    end: number;
    text: string;
    track: number;
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function visibleSubtitleText(text: string): string {
    return text
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

export function stripAssTypesetting(text: string): string {
    return text
        .replace(ASS_OVERRIDE_TAG, '')
        .replace(ASS_DRAWING_COMMAND, '')
        .replace(/\\[nN]/g, '\n')
        .replace(/\\h/g, ' ')
        .replace(/[^\S\n]+\n/g, '\n')
        .replace(/\n[^\S\n]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

const wrapFormatting = (text: string, fragment: DialogueFragment, asHtml: boolean) => {
    let result = escapeHtml(text);
    const tag = fragment.tag;

    if (!asHtml || tag === undefined) {
        return asHtml ? result : text;
    }

    if (tag.s) {
        result = `<s>${result}</s>`;
    }

    if (tag.u) {
        result = `<u>${result}</u>`;
    }

    if (tag.i) {
        result = `<i>${result}</i>`;
    }

    if (tag.b) {
        result = `<b>${result}</b>`;
    }

    return result;
};

export function assDialogueText(dialogue: Dialogue, asHtml: boolean): string {
    const parts: string[] = [];

    for (const slice of dialogue.slices) {
        for (const fragment of slice.fragments) {
            if (fragment.drawing) {
                continue;
            }

            const text = fragment.text.replace(/\\[nN]/g, '\n').replace(/\\h/g, ' ');

            if (text === '') {
                continue;
            }

            parts.push(wrapFormatting(text, fragment, asHtml));
        }
    }

    return stripAssTypesetting(parts.join(''));
}

export function isLetterLikeCue(text: string): boolean {
    const visible = visibleSubtitleText(text).trim();

    if (visible === '' || /[\n\r]/.test(visible)) {
        return false;
    }

    if (Array.from(visible).length > 2) {
        return false;
    }

    return /[\p{L}\p{N}]/u.test(visible);
}

const LETTER_CUE_GAP_MS = 300;
const LETTER_CUE_SPAN_MS = 2000;

export function mergeOverlappingLetterCues<T extends AssCue>(nodes: T[]): T[] {
    if (nodes.length < 2) {
        return nodes;
    }

    const byTrack = new Map<number, T[]>();

    for (const node of nodes) {
        const group = byTrack.get(node.track);

        if (group === undefined) {
            byTrack.set(node.track, [node]);
        } else {
            group.push(node);
        }
    }

    const merged: T[] = [];

    for (const group of byTrack.values()) {
        group.sort((a, b) => a.start - b.start);
        merged.push(...mergeLetterCuesOnTrack(group));
    }

    return merged.sort((a, b) => a.start - b.start || a.track - b.track);
}

function mergeLetterCuesOnTrack<T extends AssCue>(nodes: T[]): T[] {
    const merged: T[] = [];
    let mergingLetters = false;

    for (const node of nodes) {
        const prev = merged[merged.length - 1];

        if (prev !== undefined && canMergeLetterCues(prev, node, mergingLetters)) {
            merged[merged.length - 1] = {
                ...prev,
                end: Math.max(prev.end, node.end),
                text: `${prev.text}${node.text}`,
            };
            mergingLetters = true;
            continue;
        }

        merged.push(node);
        mergingLetters = isLetterLikeCue(node.text);
    }

    return merged;
}

function canMergeLetterCues(prev: AssCue, next: AssCue, mergingLetters: boolean): boolean {
    if (prev.track !== next.track || !isLetterLikeCue(next.text)) {
        return false;
    }

    if (!mergingLetters && !isLetterLikeCue(prev.text)) {
        return false;
    }

    if (next.start - prev.start > LETTER_CUE_SPAN_MS) {
        return false;
    }

    const overlaps = prev.start < next.end && next.start < prev.end;
    const adjacent = next.start - prev.end <= LETTER_CUE_GAP_MS;
    return overlaps || adjacent;
}
