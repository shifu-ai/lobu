import {
  getActiveSession,
  resolveOrg,
  setActiveOrg,
} from "./_lib/openclaw-auth.js";
import { isJson, printJson, printText } from "./_lib/output.js";

interface OrgOptions {
  storePath?: string;
}

export async function memoryOrgCurrentCommand(options: OrgOptions = {}): Promise<void> {
  const { session, key } = await getActiveSession(options.storePath);
  const org = await resolveOrg(undefined, session, options.storePath);

  if (isJson()) {
    printJson({ org: org || null, server: key });
    return;
  }

  printText(`org: ${org || "(none)"}`);
  printText(`server: ${key || "(none)"}`);
}

export async function memoryOrgSetCommand(
  orgSlug: string,
  options: OrgOptions = {}
): Promise<void> {
  await setActiveOrg(orgSlug, options.storePath);

  if (isJson()) {
    printJson({ org: orgSlug });
  } else {
    printText(`Default memory org: ${orgSlug}`);
  }
}
