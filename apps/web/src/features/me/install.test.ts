import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { captureInstallPrompt, isIos, useInstall } from './install';

describe('isIos', () => {
  it('recognises iPhone, iPad and iPadOS desktop mode', () => {
    expect(isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5)).toBe(true);
    expect(isIos('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 5)).toBe(true);
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 5)).toBe(true);
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 0)).toBe(false);
    expect(isIos('Mozilla/5.0 (Linux; Android 15)', 5)).toBe(false);
  });
});

describe('install prompt', () => {
  it('keeps Chromium\'s prompt and shows it once on demand', async () => {
    captureInstallPrompt(window);
    const { result } = renderHook(() => useInstall());
    expect(result.current.canPrompt).toBe(false);

    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: vi.fn(async () => undefined),
      userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    });
    act(() => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(result.current.canPrompt).toBe(true);

    let accepted = false;
    await act(async () => { accepted = await result.current.prompt(); });
    expect(accepted).toBe(true);
    expect(event.prompt).toHaveBeenCalledOnce();
    expect(result.current.canPrompt).toBe(false);
    expect(await result.current.prompt()).toBe(false);
  });
});
