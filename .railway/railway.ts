import { bucket, defineRailway, github, postgres, project, service, volume } from "railway/iac";

export default defineRailway((ctx) => {
  if (ctx.isEnvironment("customer-sandbox")) {
    const PostgresXihR = postgres("Postgres-XihR", { region: "us-west2" });
    PostgresXihR.networking = { privateNetworkEndpoint: "postgres-xihr" };

    const sandboxPostgresVolume = volume("postgres-volume-xlJ6", {
      alerts: { usage: { "80": {}, "95": {}, "100": {} } },
      allowOnlineResize: true,
      region: "us-west2",
      sizeMB: 50000,
    });

    const wms365Sandbox = service("wms365-sandbox", {
      source: github("wms365com-dev/wms365Scanner", {
        branch: "codex/production-release",
      }),
      build: { buildCommand: "npm run check:deploy", buildEnvironment: "V3", builder: "RAILPACK" },
      start: "node server.js",
      healthcheck: "/api/health",
      replicas: { "us-west2": 1 },
      deploy: { restartPolicyMaxRetries: 10, restartPolicyType: "ON_FAILURE" },
    });

    return project("WMS365 Live", {
      variables: { managed: false },
      resources: [wms365Sandbox, PostgresXihR, sandboxPostgresVolume],
    });
  }

  if (!ctx.isEnvironment("production")) {
    throw new Error(`Unsupported Railway environment: ${ctx.environmentName}`);
  }

  const Postgres = postgres("Postgres", { region: "us-west2" });
  Postgres.networking = { privateNetworkEndpoint: "postgres", tcpProxies: { "5432": {} } };

  const postgresVolume = volume("postgres-volume", {
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
    allowOnlineResize: true,
    region: "us-west2",
    sizeMB: 5000,
  });

  const PostgresPITR = bucket("Postgres-PITR", { region: "sjc" });

  const RanchersOrderFlow = service("Ranchers-Order-Flow", {
    build: { buildEnvironment: "V3", builder: "RAILPACK" },
    start: "npm start",
    replicas: { "us-west2": 1 },
    deploy: { cronSchedule: "*/30 * * * *", restartPolicyType: "NEVER" },
    networking: { privateNetworkEndpoint: "ranchers-order-flow" },
  });

  const wms365Scanner = service("wms365Scanner", {
    source: github("wms365com-dev/wms365Scanner", {
      branch: "codex/production-release",
      // Production advances only through an explicit reviewed IaC promotion.
      commitSha: "f1e4777b36e9ac2137f8684792467cd7d70f6d24",
    }),
    build: { buildCommand: "npm run check:deploy", buildEnvironment: "V3", builder: "RAILPACK" },
    start: "node server.js",
    healthcheck: "/api/health",
    replicas: { "us-west2": 1 },
    deploy: { restartPolicyMaxRetries: 10, restartPolicyType: "ON_FAILURE" },
    domains: ["app.wms365.co", "wms365.co", "www.wms365.co"],
    networking: { privateNetworkEndpoint: "wms365scanner" },
  });

  const WMS365DeliveryTracking = service("WMS365-Delivery-Tracking", {
    build: { buildEnvironment: "V3", builder: "RAILPACK" },
    replicas: { "us-west2": 1 },
    networking: { privateNetworkEndpoint: "wms365-delivery-tracking" },
  });

  return project("WMS365 Live", {
    variables: { managed: false },
    resources: [
      RanchersOrderFlow,
      wms365Scanner,
      WMS365DeliveryTracking,
      Postgres,
      postgresVolume,
      PostgresPITR,
    ],
  });
});
