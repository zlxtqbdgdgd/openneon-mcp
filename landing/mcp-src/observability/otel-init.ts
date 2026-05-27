/**
 * otel-init.ts · feat-031/#1 · OTel SDK bootstrap (OTLP HTTP exporter)
 *
 * 启动期 init `@opentelemetry/sdk-node` + OTLP HTTP trace exporter · 让本 process 产生的 span
 * (包括 audit-emit.ts emit 的 audit span) 通过 OTLP-Protobuf 出口到用户自部署 collector。
 *
 * 设计依据: feat-031 详设 §3.2 (c) + §4 env 配置 + §11 OQ1 fail-safety。
 *
 * 职责:
 *   - 读 OTEL_EXPORTER_OTLP_ENDPOINT (默认 `http://localhost:4318/v1/traces`)
 *   - resource attribute: service.name=openneon-mcp · service.version=<pkg.version> ·
 *     deployment.environment=<OTEL_DEPLOYMENT_ENV / NODE_ENV>
 *   - honors OTEL_SDK_DISABLED=true (完全 no-op · 紧急 unblock 用 · §8 回滚)
 *   - 幂等 (重复调用第二次后无副作用 · 防 hot-reload 双 init)
 *
 * fail-safety: collector 不可达不阻塞 tool · BatchSpanProcessor 内置 retry + drop · 上层 emit
 *   API 永不抛 (audit-emit.ts 单独处理 local file fallback)。
 *
 * 联动: app/api/[transport]/route.ts 在 import 顺序最前面 import 本文件 (跟 sentry/instrument 一样)。
 */
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import pkg from '../../package.json';

const SERVICE_NAME = 'openneon-mcp';
const DEFAULT_OTLP_ENDPOINT = 'http://localhost:4318/v1/traces';

let sdk: NodeSDK | null = null;
let started = false;

/**
 * 启动 OTel SDK · 幂等。OTEL_SDK_DISABLED=true 时直接返回 (no-op)。
 *
 * @returns true = 启动成功 · false = disabled / 已启动 / 启动失败 (失败 log warn 不抛)
 */
export function initOtel(): boolean {
  if (process.env.OTEL_SDK_DISABLED === 'true') return false;
  if (started) return false;

  // 调高 OTel 内部 diag log level (collector 错走 stderr · 不打到业务 logger)
  if (process.env.OTEL_LOG_LEVEL === 'debug') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    (process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces`
      : DEFAULT_OTLP_ENDPOINT);

  const deploymentEnv =
    process.env.OTEL_DEPLOYMENT_ENV ?? process.env.NODE_ENV ?? 'development';

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: pkg.version,
    'deployment.environment': deploymentEnv,
  });

  const traceExporter = new OTLPTraceExporter({ url: endpoint });

  try {
    sdk = new NodeSDK({
      resource,
      traceExporter,
    });
    sdk.start();
    started = true;
    return true;
  } catch (err) {
    // 启动失败 (e.g. invalid endpoint) · 不阻塞业务 · audit-emit 自己 fall back to local file / warn

    console.warn('[otel-init] OTel SDK 启动失败 (audit 走 fallback):', err);
    sdk = null;
    return false;
  }
}

/** 测试用 · 关掉 sdk + 重置状态 · 不导出给业务代码。 */
export async function __shutdownOtelForTest(): Promise<void> {
  if (sdk) {
    try {
      await sdk.shutdown();
    } catch {
      // ignore
    }
    sdk = null;
  }
  started = false;
}

/** 测试用 · 查询是否已 init。 */
export function __isOtelStartedForTest(): boolean {
  return started;
}
