import { validateSettings } from '@project/common/settings/settings-import-export';
import { defaultSettings } from '@project/common/settings/settings-provider';
import type { AsbplayerSettings } from '@project/common/settings';
import type { ExtensionSettingsStorage } from '@/services/extension-settings-storage';
import seedSettings from '@/assets/seed-from-profile11.json';

const knownKeys = new Set(Object.keys(defaultSettings));

function knownSettingsOnly(raw: Record<string, unknown>): Partial<AsbplayerSettings> {
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (knownKeys.has(key)) {
            filtered[key] = value;
        }
    }
    return filtered as Partial<AsbplayerSettings>;
}

export async function importSeedSettingsIfEmpty(storage: ExtensionSettingsStorage): Promise<boolean> {
    const existing = await storage.get({ deck: defaultSettings.deck });
    if (existing.deck && existing.deck.length > 0) {
        return false;
    }

    const merged = validateSettings({
        ...knownSettingsOnly(seedSettings as Record<string, unknown>),
        primingSettings: defaultSettings.primingSettings,
        tabName: 'asbplayer Prime',
    });

    await storage.set(merged);
    return true;
}
