/**
 * pi-llm-wiki — Shared type definitions.
 * Extends upstream types where narrow casts are needed.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Extended context with parent/fork session tracking */
export interface ExtendedContext extends ExtensionContext {
  parentSessionId?: string;
  forkParentId?: string;
}
