// Prometheus and Grafana, deployed via the kube-prometheus-stack Helm chart, plus the
// Guestbook-specific scrape configuration and a provisioned dashboard.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";

import { ExposedServiceType, metricsPortName, partOfGuestbook } from "./guestbook";

/** Fixed so the Grafana Service name, and therefore its URL, is predictable. */
const releaseName = "kube-prometheus-stack";

export interface MonitoringArgs {
    namespace: pulumi.Input<string>;
    chartVersion: string;
    /** Namespace holding the Guestbook Services to scrape. */
    scrapeNamespace: pulumi.Input<string>;
    grafanaServiceType: ExposedServiceType;
    grafanaNodePort?: number;
    grafanaAdminUser: pulumi.Input<string>;
    grafanaAdminPassword: pulumi.Input<string>;
}

export interface Monitoring {
    release: k8s.helm.v3.Release;
    serviceMonitor: k8s.apiextensions.CustomResource;
    dashboard: k8s.core.v1.ConfigMap;
    /** Name of the Service fronting Grafana. */
    grafanaServiceName: string;
    /** Name of the Service fronting Prometheus. */
    prometheusServiceName: string;
}

export function monitoring(args: MonitoringArgs, opts?: pulumi.CustomResourceOptions): Monitoring {
    const grafanaServiceName = `${releaseName}-grafana`;
    const prometheusServiceName = `${releaseName}-prometheus`;

    const release = new k8s.helm.v3.Release(releaseName, {
        name: releaseName,
        chart: "kube-prometheus-stack",
        version: args.chartVersion,
        namespace: args.namespace,
        repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
        // Install the CRDs and wait for the operator to be serving before anything
        // downstream tries to create a ServiceMonitor against them.
        skipAwait: false,
        timeout: 900,
        values: {
            // Alerting is out of scope for this exercise, and omitting it keeps the
            // footprint small enough for a single-node development cluster.
            alertmanager: { enabled: false },

            prometheus: {
                prometheusSpec: {
                    // The chart defaults these selectors to "only match objects labelled with
                    // this Helm release". Our ServiceMonitor is created by Pulumi and is not
                    // part of the release, so without these the operator silently ignores it
                    // and the Guestbook is never scraped.
                    serviceMonitorSelectorNilUsesHelmValues: false,
                    podMonitorSelectorNilUsesHelmValues: false,
                    ruleSelectorNilUsesHelmValues: false,
                    probeSelectorNilUsesHelmValues: false,
                    scrapeConfigSelectorNilUsesHelmValues: false,
                    retention: "6h",
                    resources: {
                        requests: { cpu: "200m", memory: "512Mi" },
                        limits: { memory: "1Gi" },
                    },
                },
            },

            grafana: {
                adminUser: args.grafanaAdminUser,
                adminPassword: args.grafanaAdminPassword,
                service: {
                    type: args.grafanaServiceType,
                    ...(args.grafanaServiceType === "NodePort" && args.grafanaNodePort
                        ? { nodePort: args.grafanaNodePort }
                        : {}),
                },
                // The chart provisions a Prometheus datasource by default; this sidecar
                // imports any ConfigMap in the release namespace carrying the label below.
                sidecar: {
                    dashboards: {
                        enabled: true,
                        label: "grafana_dashboard",
                        labelValue: "1",
                    },
                    datasources: {
                        // Alertmanager is disabled above, so skip its datasource rather
                        // than leaving Grafana pointed at a Service that does not exist.
                        alertmanager: { enabled: false },
                    },
                },
            },
        },
    }, opts);

    // One ServiceMonitor covers all three tiers: every Guestbook Service carries the
    // `part-of` label and names its exporter port `metrics`.
    const serviceMonitor = new k8s.apiextensions.CustomResource("guestbook-servicemonitor", {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "ServiceMonitor",
        metadata: {
            name: "guestbook",
            namespace: args.namespace,
            labels: { ...partOfGuestbook, release: releaseName },
        },
        spec: {
            namespaceSelector: { matchNames: [args.scrapeNamespace] },
            selector: { matchLabels: partOfGuestbook },
            endpoints: [{
                port: metricsPortName,
                path: "/metrics",
                interval: "30s",
                scrapeTimeout: "10s",
            }],
        },
    }, { ...opts, dependsOn: release });

    const dashboardJson = fs.readFileSync(
        path.join(__dirname, "dashboards", "guestbook.json"),
        "utf8",
    );

    const dashboard = new k8s.core.v1.ConfigMap("guestbook-dashboard", {
        metadata: {
            name: "guestbook-dashboard",
            namespace: args.namespace,
            // Picked up by the Grafana dashboard sidecar configured above.
            labels: { grafana_dashboard: "1" },
        },
        data: {
            "guestbook.json": pulumi.output(args.scrapeNamespace).apply(ns =>
                dashboardJson.replace(/__NAMESPACE__/g, ns)),
        },
    }, { ...opts, dependsOn: release });

    return { release, serviceMonitor, dashboard, grafanaServiceName, prometheusServiceName };
}
