export interface IdleTimeout {
  readonly signal: AbortSignal;
  /** 清掉旧计时器并重新计时 idleMs；若已 abort 则为 no-op。 */
  reset(): void;
  /** 停止计时（幂等），之后不再 abort。 */
  dispose(): void;
  /** 立即 abort 上游（供客户端断连使用），不置 abortedByIdle。 */
  abort(): void;
  /** 是否因空闲触发了 abort。 */
  readonly abortedByIdle: boolean;
}

export function createIdleTimeout(idleMs: number): IdleTimeout {
  const controller = new AbortController();
  let abortedByIdle = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = (): void => {
    timer = setTimeout(() => {
      abortedByIdle = true;
      controller.abort();
    }, idleMs);
    timer.unref?.();
  };

  const clear = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  arm();

  return {
    signal: controller.signal,
    reset(): void {
      if (controller.signal.aborted) {
        return;
      }
      clear();
      arm();
    },
    dispose(): void {
      clear();
    },
    abort(): void {
      clear();
      controller.abort();
    },
    get abortedByIdle(): boolean {
      return abortedByIdle;
    }
  };
}
