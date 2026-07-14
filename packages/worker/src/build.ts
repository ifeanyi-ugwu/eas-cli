import {
  Artifacts,
  BuildContext,
  Builders,
  TurtleSshSession,
  runGenericJobAsync,
} from '@expo/build-tools';
import {
  Android,
  BuildJob,
  BuildMode,
  BuildPhase,
  BuildPhaseResult,
  Generic,
  Ios,
  LogMarker,
  Platform,
  errors,
} from '@expo/eas-build-job';
import { bunyan } from '@expo/logger';
import omit from 'lodash/omit';
import config from './config';
import { displayWorkerRuntimeInfo } from './displayRuntimeInfo';
import { Analytics, Event, logProjectDependenciesAsync } from './external/analytics';
import { prepareRuntimeEnvironment } from './runtimeEnvironment';
import { cleanUpWorkingdir } from './workingdir';

const DEFAULT_SSH_IDLE_TIMEOUT_SECONDS = 5 * 60;

export async function build({
  ctx,
  buildId,
  analytics,
}: {
  ctx: BuildContext;
  buildId: string;
  analytics: Analytics;
}): Promise<Artifacts> {
  const { job, logger } = ctx;
  let sshHoldPromise: Promise<void> | undefined;
  try {
    analytics.logEvent(Event.WORKER_BUILD_START, {});

    await ctx.runBuildPhase(
      BuildPhase.SPIN_UP_BUILDER,
      async () => {
        displayWorkerRuntimeInfo(ctx);
        ctx.logger.info(
          { job: omit(ctx.job, 'secrets', 'projectArchive') },
          'Builder is ready, starting build'
        );
      },
      { doNotMarkStart: true }
    );
    await ctx.runBuildPhase(BuildPhase.INSTALL_CUSTOM_TOOLS, async () => {
      if (ctx.job.builderEnvironment) {
        await prepareRuntimeEnvironment(ctx, ctx.job.builderEnvironment);
      }
    });

    const sshEnabled = Boolean(ctx.env.EAS_SSH_SESSION_ID);
    if (sshEnabled) {
      await ctx.runBuildPhase(BuildPhase.SSH_SESSION, async () => {
        try {
          ctx.logger.info('Starting an SSH debug session for this job.');
          const handle = await TurtleSshSession.startSshSessionAsync(ctx, {
            turtleSshSessionId: TurtleSshSession.getTurtleSshSessionIdOrThrow(ctx.env),
            relayServerUrl: TurtleSshSession.getSshRelayServerUrl(ctx.env),
          });
          const idleTimeoutSeconds = resolveSshIdleTimeoutSeconds(
            ctx.env.EAS_SSH_IDLE_TIMEOUT_SECONDS
          );
          const idleTimeoutMinutes = Math.round(idleTimeoutSeconds / 60);
          const workflowJobId = ctx.env.__WORKFLOW_JOB_ID;
          ctx.logger.info(
            [
              'SSH session is ready.',
              ...(workflowJobId
                ? [
                    '',
                    'Connect from your machine with:',
                    `    eas workflow:ssh ${workflowJobId}`,
                    '',
                  ]
                : []),
              `The session stays available while a client is connected and closes after ${idleTimeoutMinutes} minute(s) with none connected. If the job's work finishes first, the worker stays up until the session closes.`,
            ].join('\n')
          );

          const sshLogger = logger.child({ phase: BuildPhase.SSH_SESSION });
          sshHoldPromise = TurtleSshSession.holdSshSessionUntilIdleAsync({
            getConnectedClientCount: () => handle.getConnectedClientCountAsync(),
            ensureConnected: () => handle.ensureConnectedAsync(),
            idleTimeoutSeconds,
            logger: sshLogger,
          })
            .catch(err => {
              sshLogger.warn({ err }, 'The SSH hold ended unexpectedly.');
            })
            .then(() =>
              handle.stopAsync().catch(err => {
                sshLogger.warn({ err }, 'Failed to tear down the SSH session.');
              })
            );
        } catch (err) {
          ctx.logger.warn(
            { err },
            'Failed to establish the SSH session; the job will continue without it.'
          );
          ctx.markBuildPhaseHasWarnings();
        }
      });
    }

    let artifacts: Artifacts;

    switch (job.platform) {
      case Platform.ANDROID: {
        artifacts = await Builders.androidBuilder(ctx as BuildContext<Android.Job>);
        break;
      }
      case Platform.IOS: {
        artifacts = await Builders.iosBuilder(ctx as BuildContext<Ios.Job>);
        break;
      }
      case undefined: {
        artifacts = {};
        const buildCtx = ctx as BuildContext<Generic.Job>;
        const { runResult } = await runGenericJobAsync(buildCtx);

        if (!runResult.ok) {
          throw runResult.reason;
        }
        break;
      }
    }

    if (ctx.job.platform) {
      try {
        await logProjectDependenciesAsync(ctx as BuildContext<BuildJob>, analytics, buildId);
      } catch {
        // do nothing
      }
    }

    analytics.logEvent(Event.WORKER_BUILD_SUCCESS, {});

    return artifacts;
  } catch (err: any) {
    if ('mode' in job && ![BuildMode.CUSTOM, BuildMode.REPACK].includes(job.mode)) {
      logBuildError(logger, analytics, err);
    }
    throw err;
  } finally {
    if (sshHoldPromise) {
      await sshHoldPromise;
    }
    if (config.env === 'development') {
      await cleanUpWorkingdir();
    }
    await analytics.flushEventsAsync();
  }
}

function resolveSshIdleTimeoutSeconds(rawValue: string | undefined): number {
  const parsed = Number.parseInt(rawValue ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SSH_IDLE_TIMEOUT_SECONDS;
}

function logBuildError(logger: bunyan, analytics: Analytics, err: Error): void {
  const l = logger.child({ phase: BuildPhase.FAIL_BUILD });
  l.info({ marker: LogMarker.START_PHASE }, `Start phase: ${BuildPhase.FAIL_BUILD}`);

  if (err instanceof errors.ExpoError) {
    const internalErrorCode = err.trackingCode ?? err.errorCode;
    analytics.logEvent(Event.WORKER_BUILD_FAIL, {
      reason: err?.message,
      error_code: internalErrorCode,
      build_phase: err.buildPhase,
    });
    if (err.errorCode !== errors.ErrorCode.UNKNOWN_ERROR) {
      l.error(`Build failed: ${err.message}`);
    } else {
      l.error({ err: err.cause ?? err }, `Build failed\n`);
    }
  } else {
    // This can only happen when error is thrown outside of a build phase.
    analytics.logEvent(Event.WORKER_BUILD_FAIL, {
      reason: err?.message,
      error_code: errors.ErrorCode.UNKNOWN_ERROR,
    });
    l.error({ err }, `Build failed\n`);
  }

  l.info(
    { marker: LogMarker.END_PHASE, result: BuildPhaseResult.FAIL },
    `End phase: ${BuildPhase.FAIL_BUILD}`
  );
}
