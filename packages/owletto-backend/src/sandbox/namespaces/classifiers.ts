/**
 * ClientSDK `classifiers` namespace. Thin wrapper over `manageClassifiers`.
 */

import type { Env } from "../../index";
import { manageClassifiers } from "../../tools/admin/manage_classifiers";
import type { ToolContext } from "../../tools/registry";

export interface ClassifiersNamespace {
  list(): Promise<unknown>;
  create(input: {
    slug: string;
    name: string;
    [key: string]: unknown;
  }): Promise<unknown>;
  createVersion(input: {
    classifier_slug: string;
    [key: string]: unknown;
  }): Promise<unknown>;
  getVersions(classifier_slug: string): Promise<unknown>;
  setCurrentVersion(input: {
    classifier_slug: string;
    version_id: number;
  }): Promise<unknown>;
  generateEmbeddings(classifier_slug: string): Promise<unknown>;
  delete(classifier_slug: string): Promise<unknown>;
  classify(input: {
    classifier_slug: string;
    value: string | string[];
    entity_id?: number;
  }): Promise<unknown>;
}

export function buildClassifiersNamespace(
  ctx: ToolContext,
  env: Env
): ClassifiersNamespace {
  const call = <T>(payload: Record<string, unknown>): Promise<T> =>
    manageClassifiers(payload as never, env, ctx) as Promise<T>;

  return {
    list: () => call({ action: "list" }),
    create: (input) => call({ action: "create", ...input }),
    createVersion: (input) => call({ action: "create_version", ...input }),
    getVersions: (classifier_slug) =>
      call({ action: "get_versions", classifier_slug }),
    setCurrentVersion: (input) =>
      call({ action: "set_current_version", ...input }),
    generateEmbeddings: (classifier_slug) =>
      call({ action: "generate_embeddings", classifier_slug }),
    delete: (classifier_slug) => call({ action: "delete", classifier_slug }),
    classify: (input) => call({ action: "classify", ...input }),
  };
}
