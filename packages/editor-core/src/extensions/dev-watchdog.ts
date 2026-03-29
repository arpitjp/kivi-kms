import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

export interface DevWatchdogOptions {
  enabled?: boolean;
  blockThresholdMs?: number;
  maxTransactionsPerSec?: number;
  onBlock?: (delayMs: number) => void;
  onHighTxRate?: (txPerSec: number) => void;
}

const devWatchdogTxKey = new PluginKey<number[]>('kiviDevWatchdogTx');

function isDevEnvironment(): boolean {
  const proc = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
  if (typeof proc !== 'undefined' && proc.env?.NODE_ENV !== 'production') {
    return true;
  }
  try {
    const href =
      typeof globalThis !== 'undefined' && 'location' in globalThis
        ? String((globalThis as { location?: { href?: string } }).location?.href ?? '')
        : '';
    return href.includes('localhost') || href.includes('127.0.0.1');
  } catch {
    return false;
  }
}

function resolveEnabled(enabled: boolean | undefined): boolean {
  if (enabled === false) return false;
  if (enabled === true) return true;
  return isDevEnvironment();
}

const PROBE_INTERVAL_MS = 250;
const HIGH_TX_WARN_COOLDOWN_MS = 1000;

type DevWatchdogStorage = {
  disposeEventLoopProbe: (() => void) | null;
};

export const DevWatchdog = Extension.create<DevWatchdogOptions, DevWatchdogStorage>({
  name: 'kiviDevWatchdog',

  addOptions() {
    return {
      enabled: undefined,
      blockThresholdMs: 100,
      maxTransactionsPerSec: 60,
      onBlock: undefined,
      onHighTxRate: undefined,
    };
  },

  addStorage() {
    return {
      disposeEventLoopProbe: null,
    };
  },

  addProseMirrorPlugins() {
    if (!resolveEnabled(this.options.enabled)) {
      return [];
    }

    const maxTx = this.options.maxTransactionsPerSec ?? 60;
    const onHighTxRate = this.options.onHighTxRate;
    let lastHighTxWarn = 0;

    return [
      new Plugin<number[]>({
        key: devWatchdogTxKey,
        state: {
          init(): number[] {
            return [];
          },
          apply(_tr, prev): number[] {
            const now = Date.now();
            const windowStart = now - 1000;
            const next = prev.filter((t) => t > windowStart);
            next.push(now);
            if (next.length > maxTx) {
              if (now - lastHighTxWarn >= HIGH_TX_WARN_COOLDOWN_MS) {
                lastHighTxWarn = now;
                const rate = next.length;
                console.warn(
                  `[Kivi DevWatchdog] High transaction rate: ${rate} transactions/sec — possible update loop`,
                );
                onHighTxRate?.(rate);
              }
            }
            return next;
          },
        },
      }),
    ];
  },

  onCreate() {
    if (!resolveEnabled(this.options.enabled)) {
      return;
    }

    const blockThresholdMs = this.options.blockThresholdMs ?? 100;
    const onBlock = this.options.onBlock;
    let cleaned = false;
    let probeIntervalId: ReturnType<typeof setTimeout> | null = null;
    let zeroDelayId: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (probeIntervalId !== null) {
        clearTimeout(probeIntervalId);
        probeIntervalId = null;
      }
      if (zeroDelayId !== null) {
        clearTimeout(zeroDelayId);
        zeroDelayId = null;
      }
    };

    const scheduleProbe = () => {
      if (cleaned) return;
      probeIntervalId = setTimeout(runProbe, PROBE_INTERVAL_MS);
    };

    const runProbe = () => {
      if (cleaned) return;
      probeIntervalId = null;
      const t0 = performance.now();
      zeroDelayId = setTimeout(() => {
        zeroDelayId = null;
        if (cleaned) return;
        const delayMs = performance.now() - t0;
        if (delayMs > blockThresholdMs) {
          const rounded = Math.round(delayMs);
          console.warn(`[Kivi DevWatchdog] Event loop blocked for ${rounded}ms`);
          onBlock?.(delayMs);
        }
        scheduleProbe();
      }, 0);
    };

    runProbe();

    this.storage.disposeEventLoopProbe = () => {
      cleaned = true;
      clearTimers();
      this.storage.disposeEventLoopProbe = null;
    };
  },

  onDestroy() {
    this.storage.disposeEventLoopProbe?.();
  },
});
