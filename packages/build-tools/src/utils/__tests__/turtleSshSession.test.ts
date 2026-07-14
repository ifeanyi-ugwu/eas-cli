import { SystemError } from '@expo/eas-build-job';

import { createMockLogger } from '../../__tests__/utils/logger';
import { BuildContext } from '../../context';
import { SshConnectionConfig, UptermHost, startUptermHostAsync } from '../upterm';
import {
  getSshRelayServerUrl,
  getTurtleSshSessionIdOrThrow,
  holdSshSessionUntilIdleAsync,
  reconnectWithBudgetAsync,
  startSshSessionAsync,
} from '../turtleSshSession';

jest.mock('../retry', () => ({
  sleepAsync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../upterm', () => ({
  ...jest.requireActual('../upterm'),
  startUptermHostAsync: jest.fn(),
}));

const mockedStartUptermHost = jest.mocked(startUptermHostAsync);

describe(getTurtleSshSessionIdOrThrow, () => {
  it('returns the injected session id', () => {
    expect(getTurtleSshSessionIdOrThrow({ EAS_SSH_SESSION_ID: 'session-1' })).toBe('session-1');
  });

  it('throws when not set', () => {
    expect(() => getTurtleSshSessionIdOrThrow({})).toThrow(SystemError);
  });
});

describe(getSshRelayServerUrl, () => {
  it('returns the injected relay url', () => {
    expect(getSshRelayServerUrl({ EAS_SSH_RELAY_URL: 'wss://relay.expo.dev' })).toBe(
      'wss://relay.expo.dev'
    );
  });

  it('defaults to the public upterm relay when not set', () => {
    expect(getSshRelayServerUrl({})).toBe('wss://uptermd.upterm.dev');
  });
});

describe(reconnectWithBudgetAsync, () => {
  const neverSleep = async (): Promise<void> => {};

  it('connects on the first attempt without sleeping', async () => {
    let sleeps = 0;
    const result = await reconnectWithBudgetAsync({
      attemptsRemaining: 5,
      backoffMs: 1,
      dialAsync: async () => {},
      sleepAsync: async () => {
        sleeps += 1;
      },
    });
    expect(result).toEqual({ attemptsUsed: 1, connected: true });
    expect(sleeps).toBe(0);
  });

  it('retries and connects on a later attempt', async () => {
    let attempt = 0;
    let sleeps = 0;
    const result = await reconnectWithBudgetAsync({
      attemptsRemaining: 5,
      backoffMs: 1,
      dialAsync: async () => {
        attempt += 1;
        if (attempt < 3) {
          throw new Error('relay hiccup');
        }
      },
      sleepAsync: async () => {
        sleeps += 1;
      },
    });
    expect(result).toEqual({ attemptsUsed: 3, connected: true });
    expect(sleeps).toBe(2);
  });

  it('uses the full budget (5 attempts, 4 sleeps) then reports failure', async () => {
    let sleeps = 0;
    const failedAttempts: number[] = [];
    const result = await reconnectWithBudgetAsync({
      attemptsRemaining: 5,
      backoffMs: 1,
      dialAsync: async () => {
        throw new Error('relay down');
      },
      sleepAsync: async () => {
        sleeps += 1;
      },
      onAttemptError: (_err, attemptNumber) => failedAttempts.push(attemptNumber),
    });
    expect(result).toEqual({ attemptsUsed: 5, connected: false });
    expect(sleeps).toBe(4);
    expect(failedAttempts).toEqual([1, 2, 3, 4, 5]);
  });

  it('honors a partial remaining budget', async () => {
    const result = await reconnectWithBudgetAsync({
      attemptsRemaining: 2,
      backoffMs: 1,
      dialAsync: async () => {
        throw new Error('relay down');
      },
      sleepAsync: neverSleep,
    });
    expect(result).toEqual({ attemptsUsed: 2, connected: false });
  });
});

describe(startSshSessionAsync, () => {
  const config1: SshConnectionConfig = {
    type: 'upterm-v1',
    connectionHost: 'relay.expo.dev',
    secret: 'secret-1',
  };
  const config2: SshConnectionConfig = { ...config1, secret: 'secret-2' };

  let reportResult: { error?: { message: string } };
  let mutation: jest.Mock;
  let ctx: BuildContext;

  function makeHost(overrides: Partial<UptermHost> = {}): UptermHost {
    return {
      connectionConfig: config1,
      getConnectedClientCountAsync: jest.fn().mockResolvedValue(3),
      isAlive: jest.fn().mockReturnValue(true),
      redialAsync: jest.fn().mockResolvedValue(config2),
      stopAsync: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  beforeEach(() => {
    reportResult = {};
    mutation = jest.fn().mockReturnValue({ toPromise: async () => reportResult });
    ctx = {
      logger: createMockLogger(),
      graphqlClient: { mutation },
    } as unknown as BuildContext;
  });

  it('reports the initial config and returns a handle that delegates to the host', async () => {
    const host = makeHost();
    mockedStartUptermHost.mockResolvedValue(host);

    const handle = await startSshSessionAsync(ctx, {
      turtleSshSessionId: 'ts-1',
      relayServerUrl: 'wss://relay.expo.dev',
    });

    expect(mutation).toHaveBeenCalledWith(expect.anything(), {
      turtleSshSessionId: 'ts-1',
      connectionConfig: config1,
    });
    await handle.getConnectedClientCountAsync();
    expect(host.getConnectedClientCountAsync).toHaveBeenCalled();
    await handle.stopAsync();
    expect(host.stopAsync).toHaveBeenCalled();
  });

  it('throws when reporting the connection config fails', async () => {
    mockedStartUptermHost.mockResolvedValue(makeHost());
    reportResult = { error: { message: 'boom' } };

    await expect(
      startSshSessionAsync(ctx, { turtleSshSessionId: 'ts-1', relayServerUrl: 'wss://r' })
    ).rejects.toThrow('boom');
  });

  it('ensureConnected is a no-op while the host is alive', async () => {
    const host = makeHost({ isAlive: jest.fn().mockReturnValue(true) });
    mockedStartUptermHost.mockResolvedValue(host);

    const handle = await startSshSessionAsync(ctx, {
      turtleSshSessionId: 'ts-1',
      relayServerUrl: 'wss://r',
    });
    await handle.ensureConnectedAsync();

    expect(host.redialAsync).not.toHaveBeenCalled();
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it('redials and re-reports the fresh config when the host has dropped', async () => {
    const host = makeHost({ isAlive: jest.fn().mockReturnValue(false) });
    mockedStartUptermHost.mockResolvedValue(host);

    const handle = await startSshSessionAsync(ctx, {
      turtleSshSessionId: 'ts-1',
      relayServerUrl: 'wss://r',
    });
    await handle.ensureConnectedAsync();

    expect(host.redialAsync).toHaveBeenCalledTimes(1);
    expect(mutation).toHaveBeenLastCalledWith(expect.anything(), {
      turtleSshSessionId: 'ts-1',
      connectionConfig: config2,
    });
  });

  it('throws once the redial budget is exhausted', async () => {
    const host = makeHost({
      isAlive: jest.fn().mockReturnValue(false),
      redialAsync: jest.fn().mockRejectedValue(new Error('relay down')),
    });
    mockedStartUptermHost.mockResolvedValue(host);

    const handle = await startSshSessionAsync(ctx, {
      turtleSshSessionId: 'ts-1',
      relayServerUrl: 'wss://r',
    });

    await expect(handle.ensureConnectedAsync()).rejects.toThrow(/after 5 attempts/);
    expect(host.redialAsync).toHaveBeenCalledTimes(5);
  });
});

describe(holdSshSessionUntilIdleAsync, () => {
  const logger = createMockLogger();

  it('checks the relay connection before releasing an idle hold', async () => {
    let ensureCalls = 0;
    await holdSshSessionUntilIdleAsync({
      ensureConnected: async () => {
        ensureCalls += 1;
      },
      getConnectedClientCount: async () => 0,
      idleTimeoutSeconds: 0,
      logger,
    });
    expect(ensureCalls).toBe(1);
  });

  it('logs connect then release across a client connecting and disconnecting', async () => {
    const clientCounts = [1, 0];
    await holdSshSessionUntilIdleAsync({
      ensureConnected: async () => {},
      getConnectedClientCount: async () => clientCounts.shift() ?? 0,
      idleTimeoutSeconds: 0,
      logger,
    });
    expect(logger.info).toHaveBeenCalledWith('SSH client connected.');
    expect(logger.info).toHaveBeenCalledWith('SSH client disconnected.');
  });

  it('closes the session when the relay connection cannot be re-established', async () => {
    let clientCountCalls = 0;
    await holdSshSessionUntilIdleAsync({
      ensureConnected: async () => {
        throw new SystemError('relay down');
      },
      getConnectedClientCount: async () => {
        clientCountCalls += 1;
        return 1;
      },
      idleTimeoutSeconds: 300,
      logger,
    });
    expect(clientCountCalls).toBe(0);
  });

  it('does not close while a client stays connected, even past the idle timeout', async () => {
    let polls = 0;
    await holdSshSessionUntilIdleAsync({
      ensureConnected: async () => {
        if (polls > 3) {
          throw new SystemError('stop the loop');
        }
      },
      getConnectedClientCount: async () => {
        polls += 1;
        return 1;
      },
      idleTimeoutSeconds: 0,
      logger,
    });
    expect(polls).toBeGreaterThan(3);
  });

  it('does not advance the idle timer on an unknown client count (probe failure)', async () => {
    let polls = 0;
    await holdSshSessionUntilIdleAsync({
      ensureConnected: async () => {
        if (polls > 3) {
          throw new SystemError('stop the loop');
        }
      },
      getConnectedClientCount: async () => {
        polls += 1;
        return null;
      },
      idleTimeoutSeconds: 0,
      logger,
    });
    expect(polls).toBeGreaterThan(3);
  });
});
