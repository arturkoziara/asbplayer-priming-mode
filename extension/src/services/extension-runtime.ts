type RuntimeMessageListener = Parameters<typeof browser.runtime.onMessage.addListener>[0];

export function extensionRuntimeOnMessage() {
    return browser.runtime?.onMessage;
}

export function addExtensionRuntimeMessageListener(listener: RuntimeMessageListener) {
    extensionRuntimeOnMessage()?.addListener(listener);
}

export function removeExtensionRuntimeMessageListener(listener: RuntimeMessageListener) {
    extensionRuntimeOnMessage()?.removeListener(listener);
}
