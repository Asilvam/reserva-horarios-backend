import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { RedisService } from '../common/redis/redis.service';

type AdmissionEnterResult =
  | {
      admitted: true;
      eventType: string;
      sessionId: string;
      expiresAt: string;
      writersActive: number;
    }
  | {
      admitted: false;
      eventType: string;
      sessionId: string;
      position: number;
      etaSec: number;
      retryAfterSec: number;
      writersActive: number;
      queueSize: number;
    };

@Injectable()
export class AdmissionService {
  private readonly logger = new Logger(AdmissionService.name);
  private readonly writingMaxPerEvent: number;
  private readonly formTtlSec: number;
  private readonly retryAfterSec: number;
  private readonly avgWritingSecDefault: number;
  private readonly waitlistMaxPerEvent: number;
  private readonly waitlistSessionTtlSec: number;
  private readonly statusLogThrottleSec: number;
  private readonly statusLogState = new Map<string, { lastAt: number; lastPosition?: number }>();

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {
    this.writingMaxPerEvent = this.getPositiveConfigNumber('WRITING_MAX_PER_EVENT', 200);
    this.formTtlSec = this.getPositiveConfigNumber('FORM_TTL_SEC', 60);
    this.retryAfterSec = this.getPositiveConfigNumber('WAITLIST_RETRY_AFTER_SEC', 5);
    this.avgWritingSecDefault = this.getPositiveConfigNumber('ETA_DEFAULT_WRITING_SEC', 45);
    this.waitlistMaxPerEvent = this.getPositiveConfigNumber('WAITLIST_MAX_PER_EVENT', 100);
    this.waitlistSessionTtlSec = this.getPositiveConfigNumber('WAITLIST_SESSION_TTL_SEC', 90);
    this.statusLogThrottleSec = this.getPositiveConfigNumber('ADMISSION_STATUS_LOG_THROTTLE_SEC', 15);
  }

  private getPositiveConfigNumber(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }

    if (raw !== undefined) {
      this.logger.warn(`Invalid config value for ${key}: "${raw}". Using fallback ${fallback}.`);
    }
    return fallback;
  }

  private normalizeEventType(eventType: string): string {
    return eventType.trim().toLowerCase();
  }

  private writersKey(eventType: string): string {
    return `event:${eventType}:admission:writers`;
  }

  private waitlistKey(eventType: string): string {
    return `event:${eventType}:admission:waitlist`;
  }

  private sessionKey(eventType: string, sessionId: string): string {
    return `event:${eventType}:admission:session:${sessionId}`;
  }

  private metricsKey(eventType: string): string {
    return `event:${eventType}:metrics`;
  }

  private async cleanupStaleWriters(eventType: string, requestId?: string): Promise<number> {
    const redis = this.redisService.getClient();
    const writersKey = this.writersKey(eventType);
    const writerSessionIds = await redis.smembers(writersKey);

    if (writerSessionIds.length === 0) {
      return 0;
    }

    const pipeline = redis.multi();
    for (const writerSessionId of writerSessionIds) {
      pipeline.hget(this.sessionKey(eventType, writerSessionId), 'status');
    }
    const statuses = await pipeline.exec();

    const staleIds: string[] = [];
    for (let i = 0; i < writerSessionIds.length; i++) {
      const status = (statuses?.[i]?.[1] as string | null) || null;
      if (status !== 'WRITING') {
        staleIds.push(writerSessionIds[i]);
      }
    }

    if (staleIds.length > 0) {
      await redis.srem(writersKey, ...staleIds);
      this.logger.warn(
        JSON.stringify({
          event: 'admission.cleanup_stale_writers',
          requestId: requestId || null,
          eventType,
          staleCount: staleIds.length,
        }),
      );
    }

    return staleIds.length;
  }

  private async cleanupStaleWaitlist(eventType: string, requestId?: string): Promise<number> {
    const redis = this.redisService.getClient();
    const waitlistKey = this.waitlistKey(eventType);
    const waitingSessionIds = await redis.zrange(waitlistKey, 0, -1);

    if (waitingSessionIds.length === 0) {
      return 0;
    }

    const pipeline = redis.multi();
    for (const waitingSessionId of waitingSessionIds) {
      const key = this.sessionKey(eventType, waitingSessionId);
      pipeline.hget(key, 'status');
      pipeline.ttl(key);
    }
    const statuses = await pipeline.exec();

    const staleIds: string[] = [];
    for (let i = 0; i < waitingSessionIds.length; i++) {
      const statusIdx = i * 2;
      const ttlIdx = statusIdx + 1;
      const status = (statuses?.[statusIdx]?.[1] as string | null) || null;
      const ttl = Number((statuses?.[ttlIdx]?.[1] as number | null) ?? -2);
      if (status !== 'WAITING' || ttl <= 0) {
        staleIds.push(waitingSessionIds[i]);
      }
    }

    if (staleIds.length > 0) {
      await redis.zrem(waitlistKey, ...staleIds);
      this.logger.warn(
        JSON.stringify({
          event: 'admission.cleanup_stale_waitlist',
          requestId: requestId || null,
          eventType,
          staleCount: staleIds.length,
        }),
      );
    }

    return staleIds.length;
  }

  private async getWritersActive(eventType: string, requestId?: string): Promise<number> {
    await this.cleanupStaleWriters(eventType, requestId);
    return this.redisService.getClient().scard(this.writersKey(eventType));
  }

  private async getQueueSize(eventType: string, requestId?: string): Promise<number> {
    await this.cleanupStaleWaitlist(eventType, requestId);
    return this.redisService.getClient().zcard(this.waitlistKey(eventType));
  }

  private statusLogKey(eventType: string, sessionId: string, state: 'writing' | 'waiting' | 'processing') {
    return `${eventType}:${sessionId}:${state}`;
  }

  private shouldLogStatus(params: {
    eventType: string;
    sessionId: string;
    state: 'writing' | 'waiting' | 'processing';
    remainingSec?: number;
    position?: number;
  }): boolean {
    const key = this.statusLogKey(params.eventType, params.sessionId, params.state);
    const now = Date.now();
    const existing = this.statusLogState.get(key);

    if (!existing) {
      this.statusLogState.set(key, { lastAt: now, lastPosition: params.position });
      return true;
    }

    const throttleMs = this.statusLogThrottleSec * 1000;

    if (params.state === 'waiting' && typeof params.position === 'number' && existing.lastPosition !== params.position) {
      this.statusLogState.set(key, { lastAt: now, lastPosition: params.position });
      return true;
    }

    if (params.state === 'writing' && typeof params.remainingSec === 'number' && params.remainingSec <= 10) {
      this.statusLogState.set(key, { lastAt: now, lastPosition: existing.lastPosition });
      return true;
    }

    if (now - existing.lastAt >= throttleMs) {
      this.statusLogState.set(key, { lastAt: now, lastPosition: params.position ?? existing.lastPosition });
      return true;
    }

    return false;
  }

  private clearStatusLogState(eventType: string, sessionId: string) {
    this.statusLogState.delete(this.statusLogKey(eventType, sessionId, 'writing'));
    this.statusLogState.delete(this.statusLogKey(eventType, sessionId, 'waiting'));
    this.statusLogState.delete(this.statusLogKey(eventType, sessionId, 'processing'));
  }

  private async computeEtaSec(eventType: string, position: number, writersActive: number): Promise<number> {
    const redis = this.redisService.getClient();
    const avgWritingSecRaw = await redis.hget(this.metricsKey(eventType), 'avgWritingSec');
    const avgWritingSec = Number(avgWritingSecRaw || this.avgWritingSecDefault);
    const safeAvg = Number.isFinite(avgWritingSec) && avgWritingSec > 0 ? avgWritingSec : this.avgWritingSecDefault;
    const releaseRate = writersActive > 0 ? writersActive / safeAvg : 0.1;
    const safeRate = Math.max(releaseRate, 0.1);
    return Math.ceil(position / safeRate);
  }

  async enter(eventTypeInput: string, requestId?: string): Promise<AdmissionEnterResult> {
    const startedAt = Date.now();
    const eventType = this.normalizeEventType(eventTypeInput);
    const sessionId = randomUUID();
    const redis = this.redisService.getClient();

    const writersKey = this.writersKey(eventType);
    const waitlistKey = this.waitlistKey(eventType);
    const sessionKey = this.sessionKey(eventType, sessionId);

    const writersActive = await this.getWritersActive(eventType, requestId);

    if (writersActive < this.writingMaxPerEvent) {
      const expiresAtMs = Date.now() + this.formTtlSec * 1000;
      await redis.multi().sadd(writersKey, sessionId).hmset(sessionKey, { status: 'WRITING', createdAt: Date.now().toString(), expiresAt: expiresAtMs.toString() }).expire(sessionKey, this.formTtlSec).exec();

      this.logger.log(
        JSON.stringify({
          event: 'admission.enter',
          requestId: requestId || null,
          eventType,
          sessionId,
          result: 'admitted',
          writersActive: writersActive + 1,
          durationMs: Date.now() - startedAt,
        }),
      );

      return {
        admitted: true,
        eventType,
        sessionId,
        expiresAt: new Date(expiresAtMs).toISOString(),
        writersActive: writersActive + 1,
      };
    }

    const currentQueueSize = await this.getQueueSize(eventType, requestId);
    if (currentQueueSize >= this.waitlistMaxPerEvent) {
      this.logger.warn(
        JSON.stringify({
          event: 'admission.enter',
          requestId: requestId || null,
          eventType,
          sessionId,
          result: 'waitlist_full',
          writersActive,
          queueSize: currentQueueSize,
          waitlistMaxPerEvent: this.waitlistMaxPerEvent,
          durationMs: Date.now() - startedAt,
        }),
      );

      throw new HttpException(
        {
          code: 'WAITLIST_FULL',
          message: 'Sitio sin disponibilidad, intenta más tarde.',
          eventType,
          retryAfterSec: this.retryAfterSec,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    await redis
      .multi()
      .zadd(waitlistKey, Date.now(), sessionId)
      .hmset(sessionKey, { status: 'WAITING', createdAt: Date.now().toString() })
      .expire(sessionKey, this.waitlistSessionTtlSec)
      .exec();

    const rank = await redis.zrank(waitlistKey, sessionId);
    const queueSizeRaw = await redis.zcard(waitlistKey);
    const queueSize = Number.isFinite(queueSizeRaw) ? queueSizeRaw : currentQueueSize + 1;
    const position = (rank ?? 0) + 1;
    const etaSec = await this.computeEtaSec(eventType, position, writersActive);

    this.logger.warn(
      JSON.stringify({
        event: 'admission.enter',
        requestId: requestId || null,
        eventType,
        sessionId,
        result: 'waiting',
        writersActive,
        queueSize,
        position,
        etaSec,
        retryAfterSec: this.retryAfterSec,
        durationMs: Date.now() - startedAt,
      }),
    );

    return {
      admitted: false,
      eventType,
      sessionId,
      position,
      etaSec,
      retryAfterSec: this.retryAfterSec,
      writersActive,
      queueSize,
    };
  }

  async status(eventTypeInput: string, sessionId: string, requestId?: string) {
    const startedAt = Date.now();
    const eventType = this.normalizeEventType(eventTypeInput);
    const redis = this.redisService.getClient();
    const writersKey = this.writersKey(eventType);
    const waitlistKey = this.waitlistKey(eventType);
    const sessionKey = this.sessionKey(eventType, sessionId);

    const sessionData = await redis.hgetall(sessionKey);
    if (!sessionData || Object.keys(sessionData).length === 0) {
      this.clearStatusLogState(eventType, sessionId);
      const promoted = await this.tryPromoteFromWaitlist(eventType, requestId);
      if (promoted && promoted.sessionId === sessionId) {
        return this.status(eventType, sessionId, requestId);
      }

      this.logger.warn(
        JSON.stringify({
          event: 'admission.status',
          requestId: requestId || null,
          eventType,
          sessionId,
          result: 'expired',
          durationMs: Date.now() - startedAt,
        }),
      );
      return {
        status: 'EXPIRED',
        eventType,
        sessionId,
      };
    }

    const writersActive = await this.getWritersActive(eventType, requestId);

    if (writersActive < this.writingMaxPerEvent) {
      const promoted = await this.tryPromoteFromWaitlist(eventType, requestId, writersActive);
      if (promoted && promoted.sessionId === sessionId) {
        return this.status(eventType, sessionId, requestId);
      }
    }

    await this.cleanupStaleWaitlist(eventType, requestId);

    if (sessionData.status === 'WRITING') {
      const expiresAtMs = Number(sessionData.expiresAt || Date.now());
      const remainingSec = Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000));
      if (
        this.shouldLogStatus({
          eventType,
          sessionId,
          state: 'writing',
          remainingSec,
        })
      ) {
        this.logger.log(
          JSON.stringify({
            event: 'admission.status',
            requestId: requestId || null,
            eventType,
            sessionId,
            result: 'writing',
            remainingSec,
            writersActive,
            durationMs: Date.now() - startedAt,
          }),
        );
      }
      return {
        status: 'WRITING',
        eventType,
        sessionId,
        remainingSec,
        writersActive,
      };
    }

    if (sessionData.status === 'PROCESSING') {
      if (
        this.shouldLogStatus({
          eventType,
          sessionId,
          state: 'processing',
        })
      ) {
        this.logger.log(
          JSON.stringify({
            event: 'admission.status',
            requestId: requestId || null,
            eventType,
            sessionId,
            result: 'processing',
            durationMs: Date.now() - startedAt,
          }),
        );
      }
      return {
        status: 'PROCESSING',
        eventType,
        sessionId,
      };
    }

    const rank = await redis.zrank(waitlistKey, sessionId);
    if (rank === null) {
      this.clearStatusLogState(eventType, sessionId);
      const promoted = await this.tryPromoteFromWaitlist(eventType, requestId, writersActive);
      if (promoted && promoted.sessionId === sessionId) {
        return this.status(eventType, sessionId, requestId);
      }

      this.logger.warn(
        JSON.stringify({
          event: 'admission.status',
          requestId: requestId || null,
          eventType,
          sessionId,
          result: 'expired_waiting',
          durationMs: Date.now() - startedAt,
        }),
      );

      return {
        status: 'EXPIRED',
        eventType,
        sessionId,
      };
    }

    await redis.expire(sessionKey, this.waitlistSessionTtlSec);

    const position = rank + 1;
    const queueSize = await redis.zcard(waitlistKey);
    const etaSec = await this.computeEtaSec(eventType, position, writersActive);

    if (
      this.shouldLogStatus({
        eventType,
        sessionId,
        state: 'waiting',
        position,
      })
    ) {
      this.logger.log(
        JSON.stringify({
          event: 'admission.status',
          requestId: requestId || null,
          eventType,
          sessionId,
          result: 'waiting',
          position,
          queueSize,
          etaSec,
          writersActive,
          durationMs: Date.now() - startedAt,
        }),
      );
    }

    return {
      status: 'WAITING',
      eventType,
      sessionId,
      position,
      queueSize,
      etaSec,
      retryAfterSec: this.retryAfterSec,
      writersActive,
    };
  }

  async leave(eventTypeInput: string, sessionId: string, requestId?: string) {
    const startedAt = Date.now();
    const eventType = this.normalizeEventType(eventTypeInput);
    const redis = this.redisService.getClient();

    await redis.multi().srem(this.writersKey(eventType), sessionId).zrem(this.waitlistKey(eventType), sessionId).del(this.sessionKey(eventType, sessionId)).exec();

    await this.tryPromoteFromWaitlist(eventType, requestId);
    this.clearStatusLogState(eventType, sessionId);

    this.logger.log(
      JSON.stringify({
        event: 'admission.leave',
        requestId: requestId || null,
        eventType,
        sessionId,
        result: 'ok',
        durationMs: Date.now() - startedAt,
      }),
    );

    return {
      success: true,
      eventType,
      sessionId,
    };
  }

  async markProcessing(eventTypeInput: string, sessionId: string, requestId?: string) {
    const startedAt = Date.now();
    const eventType = this.normalizeEventType(eventTypeInput);
    const redis = this.redisService.getClient();

    const sessionKey = this.sessionKey(eventType, sessionId);
    const sessionData = await redis.hgetall(sessionKey);

    if (!sessionData || Object.keys(sessionData).length === 0) {
      this.clearStatusLogState(eventType, sessionId);
      this.logger.warn(
        JSON.stringify({
          event: 'admission.submit',
          requestId: requestId || null,
          eventType,
          sessionId,
          result: 'expired',
          durationMs: Date.now() - startedAt,
        }),
      );
      return {
        success: false,
        reason: 'SESSION_EXPIRED',
      };
    }

    if (sessionData.status !== 'WRITING') {
      return {
        success: true,
        eventType,
        sessionId,
      };
    }

    const createdAtMs = Number(sessionData.createdAt || Date.now());
    const writingDurationSec = Math.max(1, Math.round((Date.now() - createdAtMs) / 1000));

    await redis
      .multi()
      .srem(this.writersKey(eventType), sessionId)
      .hmset(sessionKey, {
        status: 'PROCESSING',
        writingDurationSec: writingDurationSec.toString(),
        processingAt: Date.now().toString(),
      })
      .expire(sessionKey, this.formTtlSec * 10)
      .exec();

    const metricsKey = this.metricsKey(eventType);
    const previousAvg = Number((await redis.hget(metricsKey, 'avgWritingSec')) || this.avgWritingSecDefault);
    const safePrev = Number.isFinite(previousAvg) && previousAvg > 0 ? previousAvg : this.avgWritingSecDefault;
    const ewma = Math.round(safePrev * 0.8 + writingDurationSec * 0.2);
    await redis.hset(metricsKey, 'avgWritingSec', ewma.toString());

    await this.tryPromoteFromWaitlist(eventType, requestId);

    this.logger.log(
      JSON.stringify({
        event: 'admission.submit',
        requestId: requestId || null,
        eventType,
        sessionId,
        result: 'processing',
        writingDurationSec,
        avgWritingSec: ewma,
        durationMs: Date.now() - startedAt,
      }),
    );

    return {
      success: true,
      eventType,
      sessionId,
      writingDurationSec,
      avgWritingSec: ewma,
    };
  }

  private async tryPromoteFromWaitlist(
    eventType: string,
    requestId?: string,
    currentWritersActive?: number,
  ): Promise<{ sessionId: string } | null> {
    const redis = this.redisService.getClient();
    const writersKey = this.writersKey(eventType);
    const waitlistKey = this.waitlistKey(eventType);

    const writersActive =
      typeof currentWritersActive === 'number' ? currentWritersActive : await this.getWritersActive(eventType, requestId);
    if (writersActive >= this.writingMaxPerEvent) {
      return null;
    }

    while (true) {
      const next = await redis.zrange(waitlistKey, 0, 0);
      if (!next || next.length === 0) {
        return null;
      }

      const candidateSessionId = next[0];
      const candidateSessionKey = this.sessionKey(eventType, candidateSessionId);
      const candidateStatus = await redis.hget(candidateSessionKey, 'status');
      if (candidateStatus !== 'WAITING') {
        await redis.zrem(waitlistKey, candidateSessionId);
        this.logger.warn(
          JSON.stringify({
            event: 'admission.promote_skip_stale',
            requestId: requestId || null,
            eventType,
            sessionId: candidateSessionId,
            status: candidateStatus || null,
          }),
        );
        continue;
      }

      const sessionId = candidateSessionId;
      const sessionKey = this.sessionKey(eventType, sessionId);
      const expiresAtMs = Date.now() + this.formTtlSec * 1000;

      await redis
        .multi()
        .zrem(waitlistKey, sessionId)
        .sadd(writersKey, sessionId)
        .hmset(sessionKey, {
          status: 'WRITING',
          promotedAt: Date.now().toString(),
          expiresAt: expiresAtMs.toString(),
        })
        .expire(sessionKey, this.formTtlSec)
        .exec();

      this.logger.log(
        JSON.stringify({
          event: 'admission.promote',
          requestId: requestId || null,
          eventType,
          sessionId,
          result: 'ok',
        }),
      );

      return { sessionId };
    }
  }
}
