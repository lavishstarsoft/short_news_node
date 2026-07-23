'use strict';

const { toSafeErrorMessage, isTimeoutError } = require('./errors');

/**
 * Low-level HTTP client for ai-service.
 * Injectable http client for future tests / DI.
 */
function createHttpClient(deps = {}) {
  const getConfig = deps.getConfig;
  const log = deps.log || { debug() {}, warn() {}, error() {} };

  if (typeof getConfig !== 'function') {
    throw new Error('createHttpClient requires getConfig()');
  }

  async function detectDuplicate(payload = {}) {
    const cfg = getConfig();
    const http = deps.http || require('axios');

    if (!cfg.enabled) {
      return { ok: false, source: 'disabled' };
    }

    const requestId = payload.requestId || null;
    const started = Date.now();
    const hasMedia = Boolean(
      payload.mediaUrl ||
        payload.thumbnailUrl ||
        payload.videoUrl ||
        (Array.isArray(payload.imageUrls) && payload.imageUrls.length)
    );
    // Media cascade downloads images — never use sub-second budgets.
    const timeoutMs = hasMedia
      ? Math.max(cfg.timeoutMs || 0, 12000)
      : cfg.timeoutMs;

    try {
      log.debug('AI detect request', {
        requestId,
        baseUrl: cfg.baseUrl,
        timeoutMs,
        language: payload.language || 'te',
        candidateCount: Array.isArray(payload.candidates)
          ? payload.candidates.length
          : 0,
        hasMedia,
      });

      const response = await http.post(
        `${cfg.baseUrl}/v1/detect`,
        {
          title: payload.title || '',
          content: payload.content || '',
          language: payload.language || 'te',
          image_urls: payload.imageUrls || [],
          media_url: payload.mediaUrl || null,
          media_type: payload.mediaType || null,
          thumbnail_url: payload.thumbnailUrl || null,
          video_url: payload.videoUrl || null,
          news_id: payload.newsId || null,
          candidates: payload.candidates || [],
        },
        {
          timeout: timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            'X-AI-Service-Key': cfg.apiKey,
            ...(requestId ? { 'X-Request-Id': requestId } : {}),
          },
          validateStatus: () => true,
        }
      );

      const latencyMs = Date.now() - started;

      if (response.status === 401 || response.status === 503) {
        log.warn('AI detect auth/config error', {
          requestId,
          latencyMs,
          status: response.status,
        });
        return {
          ok: false,
          source: 'error',
          error: `AI service auth/config HTTP ${response.status}`,
        };
      }

      if (response.status === 500 || response.status < 200 || response.status >= 300) {
        log.warn('AI detect HTTP error', {
          requestId,
          latencyMs,
          status: response.status,
        });
        return {
          ok: false,
          source: 'error',
          error: `AI service HTTP ${response.status}`,
        };
      }

      const data = response.data || {};
      if (data.implemented !== true) {
        log.debug('AI detect unimplemented', {
          requestId,
          latencyMs,
          phase: data.phase,
        });
        return { ok: false, source: 'unimplemented', data };
      }

      log.debug('AI detect HTTP ok', { requestId, latencyMs });
      return { ok: true, source: 'ai', data };
    } catch (err) {
      const timeout = isTimeoutError(err);
      log.warn('AI detect failed', {
        requestId,
        latencyMs: Date.now() - started,
        source: timeout ? 'timeout' : 'error',
        error: toSafeErrorMessage(err),
      });
      return {
        ok: false,
        source: timeout ? 'timeout' : 'error',
        error: toSafeErrorMessage(err),
      };
    }
  }

  return {
    detectDuplicate,
  };
}

module.exports = {
  createHttpClient,
};
