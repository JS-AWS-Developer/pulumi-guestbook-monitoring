// Copyright 2016-2025, Pulumi Corporation.  All rights reserved.
// Modifications copyright 2026 Qamar. Licensed under the Apache License 2.0.
//
// Kubernetes Guestbook with Prometheus and Grafana monitoring.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

import { ExposedServiceType, guestbook } from "./guestbook";
import { monitoring } from "./monitoring";

const config = new pulumi.Config();

const appNamespaceName = config.get("appNamespace") ?? "guestbook";
const monitoringNamespaceName = config.get("monitoringNamespace") ?? "monitoring";

// `LoadBalancer` on clusters that provide one; `NodePort` for kind, minikube, or any
// cluster without an external load balancer controller.
const configuredServiceType = config.get("serviceType") ?? "LoadBalancer";
if (configuredServiceType !== "LoadBalancer" && configuredServiceType !== "NodePort") {
    throw new Error(
        `serviceType must be "LoadBalancer" or "NodePort", got "${configuredServiceType}"`,
    );
}
const serviceType: ExposedServiceType = configuredServiceType;

const frontendNodePort = config.getNumber("frontendNodePort") ?? 30080;
const grafanaNodePort = config.getNumber("grafanaNodePort") ?? 30300;

// Address the node ports are reachable on. `localhost` suits the kind configuration in
// kind-cluster.yaml, which maps both node ports onto the host.
const nodeAddress = config.get("nodeAddress") ?? "localhost";

const adminUser = config.get("grafanaAdminUser") ?? "admin";
// Required, and must be stored encrypted:
//   pulumi config set --secret grafanaAdminPassword <value>
const adminPassword = config.requireSecret("grafanaAdminPassword");

const chartVersion = config.get("kubePrometheusStackVersion") ?? "92.15.0";

const appNs = new k8s.core.v1.Namespace("guestbook", {
    metadata: { name: appNamespaceName },
});

const monitoringNs = new k8s.core.v1.Namespace("monitoring", {
    metadata: { name: monitoringNamespaceName },
});

const app = guestbook({
    namespace: appNs.metadata.name,
    frontendServiceType: serviceType,
    frontendNodePort,
}, { parent: appNs });

const mon = monitoring({
    namespace: monitoringNs.metadata.name,
    chartVersion,
    scrapeNamespace: appNs.metadata.name,
    grafanaServiceType: serviceType,
    grafanaNodePort,
    grafanaAdminUser: adminUser,
    grafanaAdminPassword: adminPassword,
}, { parent: monitoringNs });

/** Reads the external address off a Service, once the cluster has assigned one. */
function loadBalancerUrl(service: k8s.core.v1.Service): pulumi.Output<string> {
    // AWS load balancers report a hostname, most other implementations an IP.
    return service.status.loadBalancer.ingress[0].apply(i => `http://${i.hostname || i.ip}`);
}

export const guestbookNamespace = appNs.metadata.name;
export const monitoringNamespace = monitoringNs.metadata.name;

export const grafanaUrl: pulumi.Output<string> = serviceType === "NodePort"
    ? pulumi.interpolate`http://${nodeAddress}:${grafanaNodePort}`
    : loadBalancerUrl(k8s.core.v1.Service.get(
        "grafana-service",
        pulumi.interpolate`${monitoringNs.metadata.name}/${mon.grafanaServiceName}`,
        { dependsOn: mon.release },
    ));

export const grafanaAdminUser = adminUser;
// Encrypted in the stack state. Read with:
//   pulumi stack output grafanaAdminPassword --show-secrets
export const grafanaAdminPassword = adminPassword;

export const frontendUrl: pulumi.Output<string> = serviceType === "NodePort"
    ? pulumi.interpolate`http://${nodeAddress}:${frontendNodePort}`
    : loadBalancerUrl(app.frontend.service);

// Prometheus stays a ClusterIP Service on purpose: its UI is unauthenticated, so it is
// reached through a port-forward rather than exposed outside the cluster.
export const prometheusPortForwardCommand =
    pulumi.interpolate`kubectl port-forward -n ${monitoringNs.metadata.name} svc/${mon.prometheusServiceName} 9090:9090`;
