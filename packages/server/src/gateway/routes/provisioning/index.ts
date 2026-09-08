import type { Hono } from "hono";
import type { Env } from "../../../index.js";
import { createProvisioningRoutes as createBaseProvisioningRoutes } from "../../../lobu/provisioning-routes.js";
import { createSalesBattleReportScheduleProvisioningRoutes } from "./sales-battle-report-schedules.js";
import { createSubagentProvisioningRoutes } from "../../subagents/provisioning-routes";
import type { IMessageQueue } from "../../infrastructure/queue/types";

export {
	buildSalesBattleReportScheduledJobs,
	ensureSalesBattleReportScheduledJobs,
} from "./sales-battle-report-schedules.js";

type ProvisioningRoutesOptions = Parameters<
	typeof createBaseProvisioningRoutes
>[0] & { subagentQueue?: IMessageQueue };

export function createProvisioningRoutes(
	options: ProvisioningRoutesOptions = {},
): Hono<{ Bindings: Env }> {
	const routes = createBaseProvisioningRoutes(options);
	routes.route("/", createSalesBattleReportScheduleProvisioningRoutes());
	routes.route("/", createSubagentProvisioningRoutes({ queue: options.subagentQueue }));
	return routes;
}

export const provisioningRoutes = createProvisioningRoutes();
