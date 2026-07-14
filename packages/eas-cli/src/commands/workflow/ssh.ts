import spawnAsync from '@expo/spawn-async';
import { Flags } from '@oclif/core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import EasCommand from '../../commandUtils/EasCommand';
import { ExpoGraphqlClient } from '../../commandUtils/context/contextUtils/createGraphqlClient';
import {
  TurtleSshSession,
  TurtleSshSessionQuery,
} from '../../graphql/queries/TurtleSshSessionQuery';
import Log from '../../log';
import { ora } from '../../ora';
import { sleepAsync } from '../../utils/promise';

export const CONNECTION_HOST_REGEX = /^[A-Za-z0-9.-]+$/;
export const CONNECTION_SECRET_REGEX = /^[A-Za-z0-9._~:/+=-]+$/;

const SESSION_OPEN_TIMEOUT_MS = 5 * 60 * 1000;
const SESSION_OPEN_POLL_INTERVAL_MS = 3000;

export type SshConnectStatus = 'not-enabled' | 'ended' | 'pending' | 'ready';

export function resolveSshConnectStatus(
  session: Pick<TurtleSshSession, 'closedAt' | 'connectionConfig'> | null
): SshConnectStatus {
  if (!session) {
    return 'not-enabled';
  }
  if (session.closedAt) {
    return 'ended';
  }
  if (!session.connectionConfig) {
    return 'pending';
  }
  return 'ready';
}

export function parseSshArgv(rawArgv: readonly string[]): {
  showConnect: boolean;
  resourceId: string | undefined;
  command: string[];
} {
  let showConnect = false;
  let index = 0;
  while (index < rawArgv.length && rawArgv[index].startsWith('-')) {
    if (rawArgv[index] === '--show-connect' || rawArgv[index] === '--show-connect=true') {
      showConnect = true;
    }
    index += 1;
  }
  const [resourceId, ...command] = rawArgv.slice(index);
  return { showConnect, resourceId, command };
}

export default class WorkflowSsh extends EasCommand {
  static override hidden = true;

  static override description =
    '[EXPERIMENTAL] open an ssh session on the worker running a workflow job';

  static override strict = false;

  static override flags = {
    'show-connect': Flags.boolean({
      description: 'Print the ssh connection command (host and token) instead of opening a session',
      default: false,
    }),
  };

  static override contextDefinition = {
    ...this.ContextOptions.LoggedIn,
  };

  private isRunningSubprocess = false;

  async runAsync(): Promise<void> {
    const rawArgv = [...this.argv];
    await this.parse(WorkflowSsh, []);
    const { showConnect, resourceId, command } = parseSshArgv(rawArgv);

    if (typeof resourceId !== 'string' || resourceId.length === 0) {
      throw new Error(
        'Provide a workflow job, job run, or build id: eas workflow:ssh <id> [command...]'
      );
    }

    const {
      loggedIn: { graphqlClient },
    } = await this.getContextAsync(WorkflowSsh, { nonInteractive: true });

    const session = await TurtleSshSessionQuery.forResourceIdAsync(graphqlClient, resourceId);
    const status = resolveSshConnectStatus(session);
    if (status === 'not-enabled') {
      Log.error(
        `No ssh session for "${resourceId}". Pass a workflow job, job run, or build id from a run started with \`eas workflow:run --ssh\`.`
      );
      process.exitCode = 1;
      return;
    }
    if (status === 'ended') {
      Log.error('This ssh session has ended because the job reached a terminal state.');
      process.exitCode = 1;
      return;
    }

    const connectionConfig =
      session?.connectionConfig ?? (await waitForSessionToOpenAsync(graphqlClient, resourceId));
    if (!connectionConfig) {
      process.exitCode = 1;
      return;
    }

    const { connectionHost, secret } = connectionConfig;
    if (!CONNECTION_HOST_REGEX.test(connectionHost)) {
      throw new Error(
        'Unexpected connection host reported for this ssh session. Update eas-cli and try again, or contact support if it persists.'
      );
    }
    if (!CONNECTION_SECRET_REGEX.test(secret)) {
      throw new Error(
        'Unexpected connection token reported for this ssh session. Update eas-cli and try again, or contact support if it persists.'
      );
    }

    if (showConnect) {
      Log.log(
        `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${secret}@${connectionHost}`
      );
      return;
    }

    const configDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'eas-workflow-ssh-'));
    try {
      const configPath = path.join(configDir, 'config');
      await fs.promises.writeFile(
        configPath,
        [
          'Host eas-workflow-ssh',
          `  HostName ${connectionHost}`,
          `  User ${secret}`,
          '  StrictHostKeyChecking no',
          '  UserKnownHostsFile /dev/null',
          '',
        ].join('\n'),
        { mode: 0o600 }
      );

      this.isRunningSubprocess = true;
      await spawnAsync('ssh', ['-F', configPath, 'eas-workflow-ssh', ...command], {
        stdio: 'inherit',
      });
    } finally {
      await fs.promises.rm(configDir, { recursive: true, force: true });
    }
  }

  protected override catch(err: Error): Promise<void> {
    if (this.isRunningSubprocess) {
      const status = (err as Error & { status?: number | null }).status;
      process.exitCode = process.exitCode ?? status ?? 1;
      return Promise.resolve();
    }
    return super.catch(err);
  }
}

async function waitForSessionToOpenAsync(
  graphqlClient: ExpoGraphqlClient,
  resourceId: string
): Promise<NonNullable<TurtleSshSession['connectionConfig']> | null> {
  const spinner = ora('Waiting for the worker to open the ssh session').start();
  const deadline = Date.now() + SESSION_OPEN_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      await sleepAsync(SESSION_OPEN_POLL_INTERVAL_MS);
      const session = await TurtleSshSessionQuery.forResourceIdAsync(graphqlClient, resourceId);
      const status = resolveSshConnectStatus(session);
      if (status === 'not-enabled' || status === 'ended') {
        spinner.fail('The ssh session ended before it opened.');
        return null;
      }
      if (status === 'ready') {
        spinner.succeed('The ssh session is ready.');
        return session?.connectionConfig ?? null;
      }
    }
    spinner.fail(
      'Timed out waiting for the ssh session to open. The worker may still be starting up; try again in a moment.'
    );
    return null;
  } catch (err) {
    spinner.stop();
    throw err;
  }
}
