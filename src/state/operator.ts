/** Reads the `definition` document from the fleet state under `root`. */
type DefinitionReader = (root: string) => string | null;

let reader: DefinitionReader | null = null;

/** Called by the devfleet CLI. Only it reads the fleet's state directly, so
 * a change to the configuration reaches the manager's launchers and
 * scheduled jobs the way it reaches every worker: as the copy fleet-sync
 * installs. The reader is handed in rather than imported because launchers
 * and the worker probe load the configuration under Node, which cannot open
 * the state database. Null undoes it (tests).
 */
export function actAsOperator(read: DefinitionReader | null): void {
  reader = read;
}

export const isOperator = (): boolean => reader !== null;

export const stateDefinition = (root: string): string | null =>
  reader?.(root) ?? null;
