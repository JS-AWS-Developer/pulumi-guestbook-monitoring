// Copyright 2026 Qamar. Licensed under the Apache License 2.0.
//
// Unit tests for the Guestbook tiers and the monitoring wiring.
//
// These run entirely against Pulumi's mock runtime, so no cluster, no credentials and no
// network access are required. Run with: npm test
//
// The assertions deliberately target the failure modes that are silent at runtime: a
// ServiceMonitor whose selector does not match the labels the Services actually carry, and
// an exporter port whose name does not match the one the ServiceMonitor selects. Both leave
// every pod Running and Ready while nothing is ever scraped.
//
// Importing the modules does not create resources; the exported functions do. So mocks are
// installed in `before`, which runs ahead of every test body.

import { before, describe, test } from "node:test";
import * as assert from "node:assert";
import * as pulumi from "@pulumi/pulumi";

import { guestbook, metricsPortName, partOfGuestbook } from "./guestbook";
import { monitoring } from "./monitoring";

/** Resolves an Output to a plain value so it can be asserted on. */
function value<T>(output: pulumi.Output<T>): Promise<T> {
    return new Promise(resolve => output.apply(resolve));
}

const guestbookArgs = {
    namespace: "guestbook",
    frontendServiceType: "NodePort" as const,
    frontendNodePort: 30080,
};

const monitoringArgs = {
    namespace: "monitoring",
    chartVersion: "92.15.0",
    scrapeNamespace: "guestbook",
    grafanaServiceType: "NodePort" as const,
    grafanaNodePort: 30300,
    grafanaAdminUser: "admin",
    grafanaAdminPassword: "test-password",
};

before(async () => {
    await pulumi.runtime.setMocks(
        {
            newResource: (args: pulumi.runtime.MockResourceArgs) => ({
                id: `${args.name}-id`,
                state: args.inputs,
            }),
            call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
        },
        "guestbook-monitoring",
        "test",
        false,
    );
});

describe("guestbook tiers", () => {
    test("every tier runs an exporter sidecar alongside the application", async () => {
        const app = guestbook(guestbookArgs);

        for (const tier of [app.frontend, app.redisLeader, app.redisReplica]) {
            const containers = await value(
                tier.deployment.spec.apply(s => s!.template.spec!.containers),
            );
            assert.strictEqual(
                containers.length,
                2,
                "expected the application container plus one exporter sidecar",
            );
            assert.ok(
                containers.some(c => c.name === "metrics-exporter"),
                "expected a container named metrics-exporter",
            );
        }
    });

    test("every Service carries the label the ServiceMonitor selects on", async () => {
        const app = guestbook(guestbookArgs);
        const [key, expected] = Object.entries(partOfGuestbook)[0];

        for (const tier of [app.frontend, app.redisLeader, app.redisReplica]) {
            const labels = await value(tier.service.metadata.apply(m => m.labels));
            assert.strictEqual(
                labels?.[key],
                expected,
                `Service is missing ${key}=${expected}; the ServiceMonitor would not match it`,
            );
        }
    });

    test("every Service exposes a port named 'metrics'", async () => {
        const app = guestbook(guestbookArgs);

        for (const tier of [app.frontend, app.redisLeader, app.redisReplica]) {
            const ports = await value(tier.service.spec.apply(s => s!.ports));
            assert.ok(
                ports?.some(p => p.name === metricsPortName),
                `Service has no port named '${metricsPortName}'; the ServiceMonitor selects by name`,
            );
        }
    });

    test("the Redis leader is pinned to a version the replica image can replicate from", async () => {
        const app = guestbook(guestbookArgs);

        const containers = await value(
            app.redisLeader.deployment.spec.apply(s => s!.template.spec!.containers),
        );
        const redis = containers.find(c => c.name === "redis-leader");

        // An unpinned or newer tag writes an RDB format the upstream replica cannot load,
        // which breaks replication silently. See NOTICE and the README design notes.
        assert.strictEqual(redis?.image, "redis:6.0.5-alpine");
    });

    test("frontend is NodePort with the requested port when configured", async () => {
        const app = guestbook(guestbookArgs);

        const spec = await value(app.frontend.service.spec);
        assert.strictEqual(spec!.type, "NodePort");
        const http = spec!.ports!.find(p => p.name === "http");
        assert.strictEqual(http?.nodePort, 30080);
    });

    test("frontend is LoadBalancer without a nodePort when configured", async () => {
        const app = guestbook({ ...guestbookArgs, frontendServiceType: "LoadBalancer" });

        const spec = await value(app.frontend.service.spec);
        assert.strictEqual(spec!.type, "LoadBalancer");
        const http = spec!.ports!.find(p => p.name === "http");
        assert.strictEqual(
            http?.nodePort,
            undefined,
            "a LoadBalancer Service must not pin a nodePort",
        );
    });

    test("Redis Services stay internal", async () => {
        const app = guestbook(guestbookArgs);

        for (const tier of [app.redisLeader, app.redisReplica]) {
            const type = await value(tier.service.spec.apply(s => s!.type));
            assert.ok(
                type === undefined || type === "ClusterIP",
                `Redis must not be exposed outside the cluster, got ${type}`,
            );
        }
    });

    test("Service names are pinned, because the tiers resolve each other by DNS", async () => {
        const app = guestbook(guestbookArgs);

        const names = await Promise.all(
            [app.frontend, app.redisLeader, app.redisReplica].map(t =>
                value(t.service.metadata.apply(m => m.name)),
            ),
        );
        assert.deepStrictEqual(names, ["frontend", "redis-leader", "redis-replica"]);
    });
});

describe("monitoring wiring", () => {
    test("the ServiceMonitor selector matches the label the Services carry", async () => {
        const mon = monitoring(monitoringArgs);

        // A CustomResource carries CRD fields dynamically, so `spec` is not statically typed.
        const spec = await value((mon.serviceMonitor as any).spec as pulumi.Output<any>);
        assert.deepStrictEqual(
            spec.selector.matchLabels,
            partOfGuestbook,
            "selector must equal the labels the Services actually carry, or nothing is scraped",
        );
    });

    test("the ServiceMonitor endpoint selects the shared metrics port by name", async () => {
        const mon = monitoring(monitoringArgs);

        // A CustomResource carries CRD fields dynamically, so `spec` is not statically typed.
        const spec = await value((mon.serviceMonitor as any).spec as pulumi.Output<any>);
        assert.strictEqual(spec.endpoints.length, 1, "one endpoint should cover all tiers");
        assert.strictEqual(spec.endpoints[0].port, metricsPortName);
        assert.strictEqual(spec.endpoints[0].path, "/metrics");
    });

    test("the ServiceMonitor reaches into the application namespace", async () => {
        const mon = monitoring(monitoringArgs);

        // A CustomResource carries CRD fields dynamically, so `spec` is not statically typed.
        const spec = await value((mon.serviceMonitor as any).spec as pulumi.Output<any>);
        assert.deepStrictEqual(spec.namespaceSelector.matchNames, ["guestbook"]);
    });

    test("Prometheus is told to consider ServiceMonitors outside its own Helm release", async () => {
        const mon = monitoring(monitoringArgs);

        const values = await value(mon.release.values as pulumi.Output<any>);
        // Without this the operator silently ignores a Pulumi-created ServiceMonitor and
        // the Guestbook is never scraped. This is the most common way the integration fails.
        assert.strictEqual(
            values.prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues,
            false,
        );
    });

    test("the dashboard ConfigMap carries the label the Grafana sidecar imports on", async () => {
        const mon = monitoring(monitoringArgs);

        const labels = await value(mon.dashboard.metadata.apply(m => m.labels));
        assert.strictEqual(labels?.["grafana_dashboard"], "1");
    });

    test("the dashboard has its namespace placeholder substituted", async () => {
        const mon = monitoring(monitoringArgs);

        const data = await value(mon.dashboard.data as pulumi.Output<Record<string, string>>);
        const json = data["guestbook.json"];

        assert.ok(!json.includes("__NAMESPACE__"), "placeholder was left unsubstituted");
        assert.ok(json.includes('namespace=\\"guestbook\\"'), "namespace was not injected");
        // Fails loudly if the dashboard file stops being valid JSON.
        assert.strictEqual(JSON.parse(json).uid, "guestbook");
    });

    test("Grafana is exposed on the requested node port", async () => {
        const mon = monitoring(monitoringArgs);

        const values = await value(mon.release.values as pulumi.Output<any>);
        assert.strictEqual(values.grafana.service.type, "NodePort");
        assert.strictEqual(values.grafana.service.nodePort, 30300);
    });

    test("Grafana as LoadBalancer does not pin a node port", async () => {
        const mon = monitoring({ ...monitoringArgs, grafanaServiceType: "LoadBalancer" });

        const values = await value(mon.release.values as pulumi.Output<any>);
        assert.strictEqual(values.grafana.service.type, "LoadBalancer");
        assert.strictEqual(values.grafana.service.nodePort, undefined);
    });

    test("the chart version is pinned", async () => {
        const mon = monitoring(monitoringArgs);

        assert.strictEqual(await value(mon.release.version), "92.15.0");
    });
});
