import { asbError } from '@project/common/util';
import type { LocalizationConfig } from '@project/extension/src/services/extension-config';
import { fetchExtensionConfig } from '@project/extension/src/services/extension-config';
import { SettingsProvider, supportedLanguages as defaultSupportedLanguages } from '@project/common/settings';
import { ExtensionSettingsStorage } from '@project/extension/src/services/extension-settings-storage';
import type { PublicPath } from 'wxt/browser';

const stringsKeyForLang = (lang: string) => `locStrings-${lang}`;
const versionKeyForLang = (lang: string) => `locVersion-${lang}`;
const settings = new SettingsProvider(new ExtensionSettingsStorage());

export interface Localization {
    lang: string;
    strings: any;
}

export const fetchLocalization = async (lang: string): Promise<Localization> => {
    const bundled = (await bundledStringsForLang(lang)) ?? (await bundledStringsForLang('en'));
    if (import.meta.env.MODE === 'development' || bundled === undefined) {
        return bundled ?? (await bundledStringsForLang('en'))!;
    }

    const cached = await cachedStringsForLang(lang);
    if (cached === undefined) {
        return bundled;
    }

    return {
        lang: bundled.lang,
        strings: mergeLocStrings(cached.strings, bundled.strings),
    };
};

const mergeLocStrings = (cached: Record<string, unknown>, bundled: Record<string, unknown>): Record<string, unknown> => {
    const merged: Record<string, unknown> = { ...cached };
    for (const [key, value] of Object.entries(bundled)) {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            const existing = merged[key];
            merged[key] = mergeLocStrings(
                existing !== null && typeof existing === 'object' && !Array.isArray(existing)
                    ? (existing as Record<string, unknown>)
                    : {},
                value as Record<string, unknown>
            );
        } else {
            merged[key] = value;
        }
    }
    return merged;
};

export const fetchSupportedLanguages = async (): Promise<string[]> => {
    const config = await fetchExtensionConfig();

    if (config === undefined) {
        return defaultSupportedLanguages;
    }

    return config.languages.map((c) => c.code);
};

export const primeLocalization = async (lang: string): Promise<void> => {
    try {
        const config = await fetchExtensionConfig();

        if (config === undefined) {
            return;
        }

        const langConfig =
            config.languages.find((c) => c.code === lang) ??
            (await fetchExtensionConfig(true))?.languages.find((c) => c.code === lang);

        if (langConfig === undefined) {
            return;
        }

        const versionKey = versionKeyForLang(lang);
        const result = await browser.storage.local.get(versionKey);
        const version = result ? (result[versionKey] as number | undefined) : undefined;

        if (version === undefined || version < langConfig.version) {
            await fetchAndCache(langConfig);
        }
    } catch (e) {
        asbError('i18n', e);
    }
};

const fetchAndCache = async ({ code, url, version }: LocalizationConfig): Promise<void> => {
    const asbplayerUrl = await settings.getSingle('streamingAppUrl');
    const effectiveUrl = url.startsWith('http://') || url.startsWith('https://') ? url : `${asbplayerUrl}/${url}`;
    try {
        const strings = await (await fetch(effectiveUrl)).json();

        if (typeof strings === 'object') {
            const versionKey = versionKeyForLang(code);
            const stringsKey = stringsKeyForLang(code);
            await browser.storage.local.set({ [stringsKey]: strings, [versionKey]: version });
        }
    } catch (e) {
        asbError('i18n', e);
    }
};

const bundledStringsForLang = async (lang: string): Promise<Localization | undefined> => {
    for (const defaultLang of defaultSupportedLanguages) {
        if (lang === defaultLang) {
            return {
                lang,
                strings: await (
                    await fetch(browser.runtime.getURL(`/asbplayer-locales/${lang}.json` as PublicPath))
                ).json(),
            };
        }
    }

    return undefined;
};

const cachedStringsForLang = async (lang: string): Promise<Localization | undefined> => {
    const stringsKey = stringsKeyForLang(lang);
    const result = await browser.storage.local.get(stringsKey);
    const strings = result ? result[stringsKey] : undefined;

    if (strings === undefined) {
        return undefined;
    }

    return { lang, strings };
};
