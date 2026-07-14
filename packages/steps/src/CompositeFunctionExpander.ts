/**
 * Expands local composite functions (`uses: ./path/to/function`) into concrete {@link BuildStep}s
 * at parse time.
 *
 * A composite function call is not executed as a single step. Its `runs.steps` are flattened into the
 * workflow with prefixed ids (`caller__inner`) so the existing step runner can execute them.
 * Each expanded step carries a {@link BuildStepCompositeFunctionScope} so `${{ steps.* }}` and
 * `${{ inputs.* }}` inside the composite function resolve against composite-function-local names, not global ones.
 */
import {
  CompositeFunctionCatalog,
  CompositeFunctionConfig,
  FunctionStep,
  JobInterpolationContext,
  ShellStep,
  Step,
  isStepFunctionStep,
  isStepShellStep,
} from '@expo/eas-build-job';

import { BuildFunctionById } from './BuildFunction';
import { BuildFunctionGroupById } from './BuildFunctionGroup';
import { BuildStep } from './BuildStep';
import { BuildStepCompositeFunctionScope } from './BuildStepCompositeFunctionScope';
import { BuildStepGlobalContext } from './BuildStepContext';
import { BuildStepEnv } from './BuildStepEnv';
import {
  BuildStepInput,
  BuildStepInputValueTypeName,
  getDisallowedInputValueError,
} from './BuildStepInput';
import { BuildStepOutput } from './BuildStepOutput';
import { BuildConfigError } from './errors';
import {
  resolveInterpolatedTarget,
  stringifyInterpolatedResult,
} from './utils/compositeFunctionInterpolation';
import { duplicates } from './utils/expodash/duplicates';
import {
  getCompositeFunctionCallWorkingDirectoryError,
  isCompositeFunctionPath,
  parseCompositeFunctionPath,
} from './utils/localCompositeFunctions';
import { createBuildStepOutputsFromDefinition, getShellStepDisplayName } from './utils/step';

const MAX_COMPOSITE_FUNCTION_NESTING_DEPTH = 10;

export type FunctionMaps = {
  buildFunctionById: BuildFunctionById;
  buildFunctionGroupById: BuildFunctionGroupById;
};

type CompositeFunctionCall = {
  compositeFunctionPath: string;
  /** Caller-assigned id used as prefix for all inner step ids and the composite function outputs step. */
  syntheticStepId: string;
  name?: string;
  /** Caller-provided input values, consumed when composite function inputs are interpolated. */
  callWith?: Record<string, unknown>;
  callIf?: string;
  parentScope?: BuildStepCompositeFunctionScope;
  inheritedEnv?: BuildStepEnv;
};

type StepOverrides = {
  env?: BuildStepEnv;
  workingDirectory?: string;
  ifCondition?: string;
};

export class CompositeFunctionExpander {
  constructor(
    private readonly ctx: BuildStepGlobalContext,
    private readonly compositeFunctionCatalog: CompositeFunctionCatalog,
    private readonly functionMaps: FunctionMaps
  ) {}

  public expandCompositeFunctionStep(
    step: FunctionStep,
    compositeFunctionPath: string,
    syntheticStepId: string
  ): BuildStep[] {
    this.rejectCompositeFunctionCallWorkingDirectory(step);
    return this.expand(
      {
        compositeFunctionPath,
        syntheticStepId,
        name: step.name,
        callWith: step.with,
        callIf: step.if,
        inheritedEnv: step.env,
      },
      new Set<string>()
    );
  }

  // The call step expands away; `working_directory` on it would never apply.
  private rejectCompositeFunctionCallWorkingDirectory(step: FunctionStep): void {
    if (step.working_directory !== undefined) {
      throw new BuildConfigError(getCompositeFunctionCallWorkingDirectoryError(step.uses));
    }
  }

  // `visited.size` is the current composite function nesting depth.
  private expand(call: CompositeFunctionCall, visited: ReadonlySet<string>): BuildStep[] {
    const { compositeFunctionPath, syntheticStepId } = call;
    this.guardAgainstRunawayRecursion(compositeFunctionPath, visited);

    const action = this.lookupCompositeFunction(compositeFunctionPath);
    const actionDisplayName = call.name ?? action.name ?? compositeFunctionPath;
    const innerSteps = action.runs.steps;

    const { stepIdMap, newIds } = this.buildInnerStepIdMap(
      innerSteps,
      syntheticStepId,
      compositeFunctionPath
    );
    const { inputs, providedInputKeys } = this.buildActionInputs(
      action,
      compositeFunctionPath,
      call.callWith
    );

    const nestedVisited = new Set(visited).add(compositeFunctionPath);

    const scope = new BuildStepCompositeFunctionScope({
      ctx: this.ctx,
      parent: call.parentScope,
      ifCondition: call.callIf,
      env: call.inheritedEnv,
      compositeFunctionPath,
      inputs,
      providedInputKeys,
      stepIdAliases: stepIdMap,
    });

    const buildSteps = innerSteps.flatMap((innerStep, index) =>
      this.expandInnerStep(innerStep, newIds[index], {
        compositeFunctionPath,
        scope,
        nestedVisited,
      })
    );

    const syntheticOutputsStep = this.maybeCreateActionOutputsStep(action, {
      syntheticStepId,
      actionDisplayName,
      scope,
      // Nested calls stay hidden; top-level composite function outputs stay public.
      isCompositeFunctionInternal: call.parentScope !== undefined,
    });

    return syntheticOutputsStep ? [...buildSteps, syntheticOutputsStep] : buildSteps;
  }

  private guardAgainstRunawayRecursion(
    compositeFunctionPath: string,
    visited: ReadonlySet<string>
  ): void {
    if (visited.has(compositeFunctionPath)) {
      const cyclePath = [...visited, compositeFunctionPath].join(' -> ');
      throw new BuildConfigError(
        `Detected a cycle while expanding composite functions: ${cyclePath}. A composite function cannot reference itself, directly or indirectly.`
      );
    }
    if (visited.size >= MAX_COMPOSITE_FUNCTION_NESTING_DEPTH) {
      throw new BuildConfigError(
        `Maximum composite function nesting depth (${MAX_COMPOSITE_FUNCTION_NESTING_DEPTH}) exceeded while expanding composite function "${compositeFunctionPath}".`
      );
    }
  }

  private lookupCompositeFunction(compositeFunctionPath: string): CompositeFunctionConfig {
    const action = this.compositeFunctionCatalog[compositeFunctionPath];
    if (!action) {
      throw new BuildConfigError(
        `Local composite function "${compositeFunctionPath}" does not exist. Expected a "function.yml" (or "function.yaml") file at "${compositeFunctionPath}" relative to the EAS project root (convention: ".eas/functions/<name>").`
      );
    }
    return action;
  }

  private expandInnerStep(
    innerStep: Step,
    newId: string,
    {
      compositeFunctionPath,
      scope,
      nestedVisited,
    }: {
      compositeFunctionPath: string;
      scope: BuildStepCompositeFunctionScope;
      nestedVisited: ReadonlySet<string>;
    }
  ): BuildStep[] {
    const overrides = this.resolveStepOverrides(innerStep);

    if (isStepFunctionStep(innerStep)) {
      if (isCompositeFunctionPath(innerStep.uses)) {
        this.rejectCompositeFunctionCallWorkingDirectory(innerStep);
        return this.expandNestedCompositeFunctionCall(innerStep, {
          compositeFunctionPath: parseCompositeFunctionPath(innerStep.uses),
          newId,
          overrides,
          scope,
          visited: nestedVisited,
        });
      }
      return this.createExpandedFunctionSteps(innerStep, {
        newId,
        overrides,
        scope,
        compositeFunctionPath,
      });
    }
    if (isStepShellStep(innerStep)) {
      return [this.createExpandedShellStep(innerStep, { newId, overrides, scope })];
    }
    throw new BuildConfigError(
      `Invalid step configuration in composite function "${compositeFunctionPath}". Step must be a shell or function step.`
    );
  }

  private resolveStepOverrides(innerStep: Step): StepOverrides {
    return {
      env: innerStep.env,
      ifCondition: innerStep.if,
      workingDirectory: innerStep.working_directory,
    };
  }

  private expandNestedCompositeFunctionCall(
    innerStep: FunctionStep,
    {
      compositeFunctionPath,
      newId,
      overrides,
      scope,
      visited,
    }: {
      compositeFunctionPath: string;
      newId: string;
      overrides: StepOverrides;
      scope: BuildStepCompositeFunctionScope;
      visited: ReadonlySet<string>;
    }
  ): BuildStep[] {
    return this.expand(
      {
        compositeFunctionPath,
        syntheticStepId: newId,
        name: innerStep.name,
        callWith: innerStep.with,
        callIf: overrides.ifCondition,
        parentScope: scope,
        inheritedEnv: overrides.env,
      },
      visited
    );
  }

  private createExpandedShellStep(
    step: ShellStep,
    {
      newId,
      overrides,
      scope,
    }: {
      newId: string;
      overrides: StepOverrides;
      scope: BuildStepCompositeFunctionScope;
    }
  ): BuildStep {
    const command = step.run;
    const displayName = getShellStepDisplayName(step);
    const outputs =
      step.outputs && createBuildStepOutputsFromDefinition(this.ctx, step.outputs, displayName);
    return new BuildStep(this.ctx, {
      id: newId,
      displayName,
      outputs,
      workingDirectory: overrides.workingDirectory,
      shell: step.shell,
      command,
      env: overrides.env,
      ifCondition: overrides.ifCondition,
      compositeFunctionScope: scope,
      isCompositeFunctionInternal: true,
      __metricsId: step.__metrics_id,
    });
  }

  private createExpandedFunctionSteps(
    step: FunctionStep,
    {
      newId,
      overrides,
      scope,
      compositeFunctionPath,
    }: {
      newId: string;
      overrides: StepOverrides;
      scope: BuildStepCompositeFunctionScope;
      compositeFunctionPath: string;
    }
  ): BuildStep[] {
    const functionId = step.uses;
    const { buildFunctionById, buildFunctionGroupById } = this.functionMaps;
    const maybeFunctionGroup = buildFunctionGroupById[functionId];
    if (maybeFunctionGroup) {
      throw new BuildConfigError(
        `Function group "${functionId}" cannot be used inside a composite function. Function groups expand to multiple steps with their own ids and do not support composite-function-level id, env, if, or working_directory overrides. Use individual function steps instead.`
      );
    }

    const buildFunction = buildFunctionById[functionId];
    if (!buildFunction) {
      throw new BuildConfigError(
        `Composite function "${compositeFunctionPath}" calls non-existent function "${functionId}".`
      );
    }

    const callInputs = step.with as Record<string, unknown> | undefined;

    return [
      buildFunction.createBuildStepFromFunctionCall(this.ctx, {
        id: newId,
        name: step.name,
        callInputs,
        workingDirectory: overrides.workingDirectory,
        shell: step.shell,
        env: overrides.env,
        ifCondition: overrides.ifCondition,
        compositeFunctionScope: scope,
        isCompositeFunctionInternal: true,
      }),
    ];
  }

  /**
   * Maps composite-function-local step ids to globally unique ids and builds the alias table for scope.
   * Without namespacing, two composite function calls with inner step `read` would collide in the workflow.
   */
  private buildInnerStepIdMap(
    innerSteps: Step[],
    syntheticStepId: string,
    compositeFunctionPath: string
  ): { stepIdMap: Map<string, string>; newIds: string[] } {
    const stepIdMap = new Map<string, string>();
    const newIds: string[] = [];
    const declaredIdList = innerSteps.map(step => step.id).filter((id): id is string => !!id);
    const duplicatedIds = duplicates(declaredIdList);
    if (duplicatedIds.length > 0) {
      throw new BuildConfigError(
        `Composite function "${compositeFunctionPath}" declares duplicated step IDs: ${duplicatedIds
          .map(id => `"${id}"`)
          .join(', ')}. Step IDs within a composite function must be unique.`
      );
    }
    const declaredIds = new Set(declaredIdList);
    let generatedStepIdCounter = 0;
    for (const innerStep of innerSteps) {
      let sourceId = innerStep.id;
      if (!sourceId) {
        do {
          sourceId = `composite_function_step_${++generatedStepIdCounter}`;
        } while (declaredIds.has(sourceId));
      }
      const newId = `${syntheticStepId}__${sourceId}`;
      stepIdMap.set(sourceId, newId);
      newIds.push(newId);
    }
    return { stepIdMap, newIds };
  }

  // Nullish `with` values are treated as absent so defaults resolve in the composite function's own scope.
  private buildActionInputs(
    action: CompositeFunctionConfig,
    compositeFunctionPath: string,
    callWith: Record<string, unknown> | undefined
  ): { inputs: Map<string, BuildStepInput>; providedInputKeys: Set<string> } {
    const inputs = new Map<string, BuildStepInput>();
    const providedInputKeys = new Set<string>();
    for (const declared of action.inputs ?? []) {
      const definition =
        typeof declared === 'string'
          ? {
              name: declared,
              type: 'string',
              required: false,
              allowedValues: undefined as unknown[] | undefined,
              defaultValue: undefined as unknown,
            }
          : {
              name: declared.name,
              type: declared.type,
              required: declared.required ?? false,
              allowedValues: declared.allowed_values,
              defaultValue: declared.default_value,
            };
      const input = new BuildStepInput(this.ctx, {
        id: definition.name,
        stepDisplayName: compositeFunctionPath,
        defaultValue: definition.defaultValue,
        required: definition.required,
        allowedValues: definition.allowedValues,
        allowedValueTypeName: this.toInputValueTypeName(
          definition.type,
          compositeFunctionPath,
          definition.name
        ),
      });
      if (callWith && Object.prototype.hasOwnProperty.call(callWith, definition.name)) {
        const value = callWith[definition.name];
        if (value !== undefined) {
          input.set(value);
        }
        if (value != null) {
          providedInputKeys.add(definition.name);
        }
      }
      const disallowedValueError = getDisallowedInputValueError(input, compositeFunctionPath);
      if (disallowedValueError) {
        throw new BuildConfigError(disallowedValueError);
      }
      inputs.set(definition.name, input);
    }
    return { inputs, providedInputKeys };
  }

  private toInputValueTypeName(
    type: string,
    compositeFunctionPath: string,
    inputName: string
  ): BuildStepInputValueTypeName {
    const supported = Object.values(BuildStepInputValueTypeName) as string[];
    if (!supported.includes(type)) {
      throw new BuildConfigError(
        `Composite function "${compositeFunctionPath}" input "${inputName}" has unsupported type "${type}". Supported types: ${supported.join(
          ', '
        )}.`
      );
    }
    return type as BuildStepInputValueTypeName;
  }

  /**
   * Action-level `outputs:` are exposed on the caller's step id (e.g. `setup.outputs.version`),
   * so callers can reference them like any other step. This synthetic step runs after the inner
   * steps and copies templated values into those outputs.
   */
  private maybeCreateActionOutputsStep(
    action: CompositeFunctionConfig,
    {
      syntheticStepId,
      actionDisplayName,
      scope,
      isCompositeFunctionInternal,
    }: {
      syntheticStepId: string;
      actionDisplayName: string;
      scope: BuildStepCompositeFunctionScope;
      isCompositeFunctionInternal: boolean;
    }
  ): BuildStep | undefined {
    const outputEntries = Object.entries(action.outputs ?? {});
    if (outputEntries.length === 0) {
      return undefined;
    }

    const outputTemplates = outputEntries.map(([name, output]) => ({
      name,
      template: output.value,
    }));

    const outputs = outputTemplates.map(
      ({ name }) =>
        new BuildStepOutput(this.ctx, {
          id: name,
          stepDisplayName: actionDisplayName,
          required: true,
        })
    );

    return new BuildStep(this.ctx, {
      id: syntheticStepId,
      displayName: actionDisplayName,
      fn: (stepCtx, { outputs: outputById, env: stepEnv }) => {
        const base: JobInterpolationContext = {
          ...stepCtx.global.getInterpolationContext(),
          env: stepEnv,
        };
        const scopedContext = scope.getScopedInterpolationContext(base);
        for (const { name, template } of outputTemplates) {
          outputById[name].set(
            stringifyInterpolatedResult(resolveInterpolatedTarget(template, scopedContext))
          );
        }
      },
      outputs,
      ifCondition: '${{ always() }}',
      compositeFunctionScope: scope,
      isCompositeFunctionInternal,
    });
  }
}
