/**
 * Deployment manager implementations
 * Add new deployment targets here (e.g., CloudflareDeploymentManager, LambdaDeploymentManager)
 */

export { DockerDeploymentManager } from "./docker-deployment.js";
export { EmbeddedDeploymentManager } from "./embedded-deployment.js";
export { K8sDeploymentManager } from "./k8s/index.js";
