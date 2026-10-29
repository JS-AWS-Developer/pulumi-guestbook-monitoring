// Copyright 2016-2025, Pulumi Corporation.  All rights reserved.
// Modifications copyright 2026 Qamar. Licensed under the Apache License 2.0.
//
// The Guestbook application: a Redis leader, a set of read-only Redis replicas,
// and a replicated PHP frontend.
//
// Neither the frontend nor Redis speaks Prometheus natively, so each tier runs a
// sidecar exporter that translates its native status into Prometheus metrics. The
// sidecar shares the pod's network namespace, which means the application image and
// configuration are left completely untouched.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

/** Label carried by every Guestbook Service; the ServiceMonitor selects on it. */
export const partOfGuestbook = { "app.kubernetes.io/part-of": "guestbook" };

/** Every Service exposing metrics names that port identically, so one ServiceMonitor covers all tiers. */
export const metricsPortName = "metrics";

/** Services the exercise exposes outside the cluster. */
export type ExposedServiceType = "LoadBalancer" | "NodePort";

interface ExporterArgs {
    image: string;
    /** Port the exporter listens on. Scraped at /metrics. */
    port: number;
    args?: string[];
}

interface TierArgs {
    /** Service name. Also the DNS name the other tiers resolve, so it is pinned explicitly. */
    name: string;
    image: string;
    replicas?: number;
    /** Port the application container listens on. */
    port: number;
    portName: string;
    namespace: pulumi.Input<string>;
    serviceType?: pulumi.Input<string>;
    nodePort?: number;
    env?: k8s.types.input.core.v1.EnvVar[];
    exporter?: ExporterArgs;
}

interface Tier {
    deployment: k8s.apps.v1.Deployment;
    service: k8s.core.v1.Service;
}

function tier(args: TierArgs, opts?: pulumi.CustomResourceOptions): Tier {
    const selectorLabels = { app: args.name };
    const podLabels = { ...selectorLabels, ...partOfGuestbook };

    const containers: k8s.types.input.core.v1.Container[] = [
        {
            name: args.name,
            image: args.image,
            ports: [{ name: args.portName, containerPort: args.port }],
            env: args.env,
            resources: {
                requests: { cpu: "100m", memory: "100Mi" },
                limits: { cpu: "250m", memory: "256Mi" },
            },
        },
    ];

    if (args.exporter) {
        containers.push({
            name: "metrics-exporter",
            image: args.exporter.image,
            args: args.exporter.args,
            ports: [{ name: metricsPortName, containerPort: args.exporter.port }],
            resources: {
                requests: { cpu: "25m", memory: "32Mi" },
                limits: { cpu: "100m", memory: "64Mi" },
            },
            readinessProbe: {
                httpGet: { path: "/metrics", port: args.exporter.port },
                initialDelaySeconds: 5,
                periodSeconds: 10,
            },
        });
    }

    const deployment = new k8s.apps.v1.Deployment(args.name, {
        metadata: { namespace: args.namespace, labels: podLabels },
        spec: {
            replicas: args.replicas,
            selector: { matchLabels: selectorLabels },
            template: {
                metadata: { labels: podLabels },
                spec: { containers },
            },
        },
    }, opts);

    const servicePorts: k8s.types.input.core.v1.ServicePort[] = [
        {
            name: args.portName,
            port: args.port,
            targetPort: args.port,
            ...(args.nodePort ? { nodePort: args.nodePort } : {}),
        },
    ];

    if (args.exporter) {
        servicePorts.push({
            name: metricsPortName,
            port: args.exporter.port,
            targetPort: args.exporter.port,
        });
    }

    const service = new k8s.core.v1.Service(args.name, {
        metadata: {
            // Pinned: the frontend and the Redis replicas find each other by DNS name.
            name: args.name,
            namespace: args.namespace,
            labels: podLabels,
        },
        spec: {
            type: args.serviceType,
            ports: servicePorts,
            selector: selectorLabels,
        },
    }, { ...opts, dependsOn: deployment });

    return { deployment, service };
}

/** Sidecar reading Redis' INFO output. Connects over the pod's loopback interface. */
function redisExporter(): ExporterArgs {
    return {
        image: "oliver006/redis_exporter:v1.69.0",
        port: 9121,
        args: ["--redis.addr=redis://127.0.0.1:6379"],
    };
}

export interface GuestbookArgs {
    namespace: pulumi.Input<string>;
    frontendServiceType: ExposedServiceType;
    frontendNodePort?: number;
}

export interface Guestbook {
    redisLeader: Tier;
    redisReplica: Tier;
    frontend: Tier;
}

export function guestbook(args: GuestbookArgs, opts?: pulumi.CustomResourceOptions): Guestbook {
    const redisLeader = tier({
        name: "redis-leader",
        // Pinned to match the replica image's Redis 6.0.5. A newer leader writes an RDB
        // format the upstream replica cannot load ("Can't handle RDB format version 12"),
        // which leaves replication permanently down. The upstream example's unpinned
        // `image: redis` hits exactly this, since `latest` is now well past 6.0.
        image: "redis:6.0.5-alpine",
        port: 6379,
        portName: "redis",
        namespace: args.namespace,
        exporter: redisExporter(),
    }, opts);

    const redisReplica = tier({
        name: "redis-replica",
        image: "pulumi/guestbook-redis-replica",
        port: 6379,
        portName: "redis",
        namespace: args.namespace,
        // Resolve the leader through DNS rather than environment variables.
        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
        exporter: redisExporter(),
    }, { ...opts, dependsOn: redisLeader.service });

    const frontend = tier({
        name: "frontend",
        image: "pulumi/guestbook-php-redis",
        replicas: 3,
        port: 80,
        portName: "http",
        namespace: args.namespace,
        serviceType: args.frontendServiceType,
        nodePort: args.frontendServiceType === "NodePort" ? args.frontendNodePort : undefined,
        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
        // The image already enables mod_status with `ExtendedStatus On`, restricted to
        // `Require local`. A sidecar is local to the pod, so it can read /server-status
        // without any change to the application's Apache configuration.
        exporter: {
            image: "lusotycoon/apache-exporter:v1.0.10",
            port: 9117,
            args: ["--scrape_uri=http://127.0.0.1/server-status?auto"],
        },
    }, { ...opts, dependsOn: [redisLeader.service, redisReplica.service] });

    return { redisLeader, redisReplica, frontend };
}
