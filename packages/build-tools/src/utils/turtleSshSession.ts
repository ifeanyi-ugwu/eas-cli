import { Env, SystemError } from '@expo/eas-build-job';
import { bunyan } from '@expo/logger';
import { graphql } from 'gql.tada';

import { sleepAsync } from './retry';
import { DEFAULT_SSH_RELAY_SERVER_URL, SshConnectionConfig, startUptermHostAsync } from './upterm';
import { BuildContext } from '../context';

const MAX_SSH_REDIALS = 5;
const REDIAL_BACKOFF_MS = 2_000;
const CLIENT_COUNT_POLL_INTERVAL_MS = 5_000;

const UPDATE_TURTLE_SSH_SESSION_CONNECTION_CONFIG_MUTATION = graphql(`
  mutation UpdateTurtleSshSessionConnectionConfig(
    $turtleSshSessionId: ID!
    $connectionConfig: JSONObject!
  ) {
    turtleSshSession {
      updateTurtleSshSessionConnectionConfig(
        turtleSshSessionId: $turtleSshSessionId
        connectionConfig: $connectionConfig
      ) {
        id
      }
    }
  }
`);

export function getTurtleSshSessionIdOrThrow(env: Env): string {
  const turtleSshSessionId = env.EAS_SSH_SESSION_ID;
  if (!turtleSshSessionId) {
    throw new SystemError(
      'EAS_SSH_SESSION_ID is not set. It should be injected into the job environment when ssh is enabled.'
    );
  }
  return turtleSshSessionId;
}

export function getSshRelayServerUrl(env: Env): string {
  return env.EAS_SSH_RELAY_URL ?? DEFAULT_SSH_RELAY_SERVER_URL;
}

export async function reconnectWithBudgetAsync({
  attemptsRemaining,
  backoffMs,
  dialAsync,
  sleepAsync: sleep,
  onAttemptError,
}: {
  attemptsRemaining: number;
  backoffMs: number;
  dialAsync: () => Promise<void>;
  sleepAsync: (ms: number) => Promise<void>;
  onAttemptError?: (err: unknown, attemptNumber: number) => void;
}): Promise<{ attemptsUsed: number; connected: boolean }> {
  let attemptsUsed = 0;
  while (attemptsUsed < attemptsRemaining) {
    attemptsUsed += 1;
    try {
      await dialAsync();
      return { attemptsUsed, connected: true };
    } catch (err) {
      onAttemptError?.(err, attemptsUsed);
      if (attemptsUsed < attemptsRemaining) {
        await sleep(backoffMs);
      }
    }
  }
  return { attemptsUsed, connected: false };
}

export type SshSessionHandle = {
  getConnectedClientCountAsync: () => Promise<number | null>;
  ensureConnectedAsync: () => Promise<void>;
  stopAsync: () => Promise<void>;
};

async function reportConnectionConfigAsync(
  ctx: BuildContext,
  {
    turtleSshSessionId,
    connectionConfig,
  }: { turtleSshSessionId: string; connectionConfig: SshConnectionConfig }
): Promise<void> {
  ctx.logger.info(`Reporting ssh connection config (turtle ssh session: ${turtleSshSessionId}).`);
  const result = await ctx.graphqlClient
    .mutation(UPDATE_TURTLE_SSH_SESSION_CONNECTION_CONFIG_MUTATION, {
      turtleSshSessionId,
      connectionConfig,
    })
    .toPromise();
  if (result.error) {
    throw new SystemError(
      `Failed to report the ssh connection config for turtle ssh session ${turtleSshSessionId}: ${result.error.message}`
    );
  }
}

export async function startSshSessionAsync(
  ctx: BuildContext,
  { turtleSshSessionId, relayServerUrl }: { turtleSshSessionId: string; relayServerUrl: string }
): Promise<SshSessionHandle> {
  const host = await startUptermHostAsync(ctx, { relayServerUrl });
  await reportConnectionConfigAsync(ctx, {
    turtleSshSessionId,
    connectionConfig: host.connectionConfig,
  });

  let redialAttemptsUsed = 0;
  const ensureConnectedAsync = async (): Promise<void> => {
    if (host.isAlive()) {
      return;
    }
    const { attemptsUsed, connected } = await reconnectWithBudgetAsync({
      attemptsRemaining: MAX_SSH_REDIALS - redialAttemptsUsed,
      backoffMs: REDIAL_BACKOFF_MS,
      sleepAsync,
      dialAsync: async () => {
        ctx.logger.warn('The SSH relay connection dropped; reconnecting.');
        const connectionConfig = await host.redialAsync();
        await reportConnectionConfigAsync(ctx, { turtleSshSessionId, connectionConfig });
      },
      onAttemptError: (err, attemptNumber) => {
        ctx.logger.warn({ err }, `SSH reconnect attempt ${attemptNumber} failed.`);
      },
    });
    redialAttemptsUsed += attemptsUsed;
    if (connected) {
      ctx.logger.info('The SSH relay connection was re-established.');
      return;
    }
    throw new SystemError(
      `The SSH relay connection dropped and could not be re-established after ${MAX_SSH_REDIALS} attempts.`
    );
  };

  return {
    getConnectedClientCountAsync: () => host.getConnectedClientCountAsync(),
    ensureConnectedAsync,
    stopAsync: () => host.stopAsync(),
  };
}

export async function holdSshSessionUntilIdleAsync({
  getConnectedClientCount,
  ensureConnected,
  idleTimeoutSeconds,
  logger,
}: {
  getConnectedClientCount: () => Promise<number | null>;
  ensureConnected: () => Promise<void>;
  idleTimeoutSeconds: number;
  logger: bunyan;
}): Promise<void> {
  const idleTimeoutMs = idleTimeoutSeconds * 1_000;
  let lastActiveAt = Date.now();
  let previousClientCount = 0;

  for (;;) {
    try {
      await ensureConnected();
    } catch (err) {
      logger.warn({ err }, 'Could not re-establish the SSH session; closing it.');
      return;
    }
    const connectedClientCount = await getConnectedClientCount();
    if (connectedClientCount !== null) {
      if (connectedClientCount > 0 && previousClientCount === 0) {
        logger.info('SSH client connected.');
      } else if (connectedClientCount === 0 && previousClientCount > 0) {
        logger.info('SSH client disconnected.');
      }
      if (connectedClientCount > 0) {
        lastActiveAt = Date.now();
      }
      previousClientCount = connectedClientCount;
      if (connectedClientCount === 0 && Date.now() - lastActiveAt >= idleTimeoutMs) {
        logger.info(`No SSH client connected for ${idleTimeoutSeconds}s; closing the SSH session.`);
        return;
      }
    }
    await sleepAsync(CLIENT_COUNT_POLL_INTERVAL_MS);
  }
}
