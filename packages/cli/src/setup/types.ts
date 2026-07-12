export type StepName = "init" | "mcp" | "smoke" | "plugin";

export type StepState = "created" | "already" | "updated" | "outdated" | "skipped" | "verified" | "failed";

export interface StepResult {
  step: StepName;
  state: StepState;
  detail: string;
}

export interface SetupOptions {
  yes: boolean;
  writeMcp?: string; // path for --write-mcp; undefined => print
  installPlugin: boolean;
  json: boolean;
}

/** Orchestrator seam: injectable I/O + the child-process env for the smoke
 * spawn. `env` MUST be threaded to the spawned server so tests can isolate its
 * journal via a temp HOME. Defaults to process.env in production. */
export interface SetupDeps {
  out?: (s: string) => void;
  promptInput?: NodeJS.ReadableStream;
  env?: NodeJS.ProcessEnv;
}

/** Collaborators the orchestrator composes — injected so units test in
 * isolation and WU-1 can drive the orchestrator with fakes. */
export interface SetupSteps {
  configureMcp(
    vault: string,
    opts: SetupOptions,
    out: (s: string) => void,
  ): Promise<{ result: StepResult; entry: string | null }>;
  smoke(vault: string, entry: string, env?: NodeJS.ProcessEnv): Promise<StepResult>;
  installPlugin(vault: string): Promise<StepResult>;
}
