import { proxyWellKnown } from "../_well-known-proxy";

type PagesFunction = (context: {
  request: Request;
  next: () => Promise<Response>;
  env: Record<string, unknown>;
  params: Record<string, string | string[]>;
}) => Promise<Response> | Response;

export const onRequest: PagesFunction = (context) => proxyWellKnown(context);
