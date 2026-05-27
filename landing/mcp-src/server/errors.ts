import { isAxiosError } from 'axios';
import { NeonDbError } from '@neondatabase/serverless';
import { logger } from '../utils/logger';
import { captureException } from '@sentry/node';
import { getApiKeys } from '../oauth/kv-store';
import { keyLast4 } from '../auth/key-resolver';

export class InvalidArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArgumentError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

function isClientError(
  error: unknown,
): error is InvalidArgumentError | NotFoundError {
  return (
    error instanceof InvalidArgumentError || error instanceof NotFoundError
  );
}

function errorResponse(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : 'Unknown error',
      },
    ],
  };
}

/**
 * feat-029/#3 · 运行期 revocation 检测：tool 调用对 Neon API 拿到 401/403 → key 被 revoke 或失效。
 * 把 5min KV cache 中该 key 的 record 清掉，让下一次 verifyToken 重新跑 resolveKeyScope · 在那
 * 一步 fail-closed deny（KeyResolverError → fetchAccountDetails 返 null → withMcpAuth 401）。
 *
 * fire-and-forget · cache 操作失败也不抛错（只 warn log · 不影响 tool error 响应）。
 */
export function invalidateRevokedApiKeyCache(apiKey: string): void {
  const last4 = keyLast4(apiKey);
  logger.warn('mcp Server detected runtime key revocation (feat-029)', {
    last4,
    outcome: 'runtime_revocation_detected',
  });
  void getApiKeys()
    .delete(apiKey)
    .catch((err) => {
      logger.warn('failed to invalidate revoked API key cache', { err, last4 });
    });
}

export function handleToolError(
  error: unknown,
  properties: Record<string, string>,
  traceId?: string,
  apiKey?: string,
) {
  // feat-029/#3: Neon API 401/403 = key 在运行期被 revoke · 主动清 KV cache · 下次 fail-closed
  if (
    isAxiosError(error) &&
    apiKey &&
    (error.response?.status === 401 || error.response?.status === 403)
  ) {
    invalidateRevokedApiKeyCache(apiKey);
  }

  if (error instanceof NeonDbError || isClientError(error)) {
    return errorResponse(error);
  } else if (
    isAxiosError(error) &&
    error.response?.status &&
    error.response?.status < 500
  ) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: error.response.data.message,
        },
        {
          type: 'text' as const,
          text: `[${error.response.statusText}] ${error.message}`,
        },
      ],
    };
  } else {
    const errorContext = { ...properties, ...(traceId && { traceId }) };
    logger.error('Tool call error:', {
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : 'Unknown error',
      ...errorContext,
    });
    captureException(error, { extra: errorContext });
    return errorResponse(error);
  }
}
